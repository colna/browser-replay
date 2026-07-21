/**
 * 端到端验证：在真实 Chrome 里跑**未经改动的** content.js / selector.js / executor.js，
 * 用 CDP Input domain 发真实（isTrusted）鼠标键盘事件录制，再让 executor 回放，
 * 最后断言「回放后的表单状态 === 录制时的表单状态」。
 *
 * 为什么不直接加载扩展：Chrome 136+ 已禁用命令行 `--load-extension`
 * （连最小 MV3 扩展都加载不了，chrome://extensions 列表为空），
 * 所以这里用 chrome API 桩把 content.js 装进普通页面跑。
 * 覆盖不到的部分只剩 background 的存储与跨页调度，需人工验证。
 *
 * 用法：node test/e2e.mjs [--headful]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import { toExport } from '../src/lib/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8899;
const HEADFUL = process.argv.includes('--headful');

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) log(`PASS  ${name}${detail ? '  —  ' + detail : ''}`);
  else {
    failures += 1;
    log(`FAIL  ${name}${detail ? '  —  ' + detail : ''}`);
  }
}

// ------------------------------------------------------------ 静态服务器

function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    // harness 用 ../src/... 引真实源码，所以根目录挂在仓库根上
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, () => resolve(server)));
}

// ------------------------------------------------------------ CDP over pipe

class CDP {
  constructor(writeStream, readStream) {
    this.write = writeStream;
    this.id = 0;
    this.pending = new Map();
    this.buffer = '';

    readStream.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let index;
      while ((index = this.buffer.indexOf('\0')) !== -1) {
        const raw = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (raw) this.handle(JSON.parse(raw));
      }
    });
  }

  handle(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write.write(JSON.stringify(payload) + '\0');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.write.end();
    } catch {
      /* 已关闭 */
    }
  }
}

// ------------------------------------------------------------ 页面操作

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
  }
  return result.result.value;
}

async function centerOf(cdp, sessionId, selector) {
  const box = await evaluate(
    cdp,
    sessionId,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`
  );
  if (!box) throw new Error(`找不到元素 ${selector}`);
  return box;
}

/** 真实鼠标点击：isTrusted = true，走浏览器真实输入管线 */
async function realClick(cdp, sessionId, selector) {
  const { x, y } = await centerOf(cdp, sessionId, selector);
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, sessionId);
  await sleep(120);
}

/** 真实键盘输入 */
async function realType(cdp, sessionId, text) {
  await cdp.send('Input.insertText', { text }, sessionId);
  await sleep(150);
}

async function waitFor(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

// ------------------------------------------------------------ 主流程

async function main() {
  const server = await startServer();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'br-e2e-'));

  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--window-size=1200,900',
    'about:blank'
  ];
  if (!HEADFUL) args.unshift('--headless=new');

  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let cdp;

  try {
    cdp = new CDP(chrome.stdio[3], chrome.stdio[4]);
    const version = await cdp.send('Browser.getVersion');
    log('已连接 Chrome:', version.product, '\n');

    const url = `http://localhost:${HTTP_PORT}/test/harness.html`;
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    await waitFor(
      () => evaluate(cdp, sessionId, 'document.readyState === "complete" && !!window.__BR_CONTENT__ && !!window.__harness'),
      'harness 与 content.js 就绪'
    );
    check('content.js 在真实页面中就绪', true);

    // ---------- 录制 ----------
    await evaluate(cdp, sessionId, 'window.__harness.startRecord()');
    await sleep(200);

    await realClick(cdp, sessionId, '#nickname');
    await realType(cdp, sessionId, 'Colna');

    // 原生 select 的下拉层在 headless 里点不开，用合成 change 代替（录制器监听的正是 change）
    await evaluate(
      cdp,
      sessionId,
      `(() => { const s = document.querySelector('[name="city"]');
        s.focus(); s.value = 'shanghai';
        s.dispatchEvent(new Event('change', { bubbles: true })); })()`
    );
    await sleep(150);

    await realClick(cdp, sessionId, '[name="agree"]');
    await realClick(cdp, sessionId, '#remark');
    await realType(cdp, sessionId, '端到端验证');
    await realClick(cdp, sessionId, '[data-testid="submit-btn"]');
    await sleep(200);

    const recorded = await evaluate(cdp, sessionId, 'window.__harness.summary()');
    check(
      '录制阶段表单确实被操作了',
      recorded === 'nickname=Colna;city=shanghai;agree=true;remark=端到端验证',
      recorded
    );

    const steps = await evaluate(cdp, sessionId, 'window.__harness.stopRecord()');
    const types = steps.map((s) => s.type);
    check('停止录制并拿到步骤', steps.length > 0, `${steps.length} 步：${types.join(' → ')}`);
    check('录到点击', types.includes('click'));
    check('录到输入', types.includes('input'));
    check('录到聚焦', types.includes('focus'));
    check('录到失焦', types.includes('blur'));
    check('录到下拉选择', types.includes('select'));
    check('录到勾选', types.includes('check'));

    const inputSteps = steps.filter((s) => s.type === 'input');
    check(
      '连续输入被合并成单步（未按键拆分）',
      inputSteps.length === 2 && inputSteps[0].value === 'Colna' && inputSteps[1].value === '端到端验证',
      inputSteps.map((s) => `${s.value}`).join(' | ')
    );

    // ---------- 选择器质量 ----------
    const allSelectors = [];
    for (const step of steps) {
      for (const c of (step.target && step.target.candidates) || []) allSelectors.push(c.value);
    }
    check(
      '所有候选选择器均不含 class',
      allSelectors.every((s) => !/(^|[^\\])\.[A-Za-z_-]|\[class/.test(s)),
      `${allSelectors.length} 个候选`
    );

    const exported = toExport({
      id: 'e2e',
      name: 'e2e',
      startUrl: url,
      createdAt: Date.now(),
      steps
    });
    const primary = exported.steps.map((s) => s.selector).filter(Boolean);
    check('导出 JSON 每步都带选择器', primary.length === steps.length, `${primary.length}/${steps.length}`);
    check(
      '导出的选择器不含 class',
      primary.every((s) => !/(^|[^\\])\.[A-Za-z_-]|\[class/.test(s)),
      primary.join(' | ')
    );
    check(
      '提交按钮用 data-testid 定位',
      primary.includes('[data-testid="submit-btn"]')
    );
    check(
      '动态 id 的 select 没用 #:r3:',
      !primary.some((s) => s.includes(':r3:')),
      primary.find((s) => s.includes('city')) || '(无)'
    );

    // ---------- 回放 ----------
    await evaluate(cdp, sessionId, 'window.__harness.reset()');
    const afterReset = await evaluate(cdp, sessionId, 'window.__harness.summary()');
    check('回放前表单已重置', afterReset === '-', afterReset);

    const replayLog = await evaluate(
      cdp,
      sessionId,
      `window.__harness.replay(${JSON.stringify(steps)})`
    );
    const failed = replayLog.filter((entry) => !entry.ok);
    check(
      '回放全部步骤成功',
      failed.length === 0,
      failed.map((f) => `#${f.index} ${f.type}: ${f.error}`).join('; ')
    );

    const replayed = await evaluate(cdp, sessionId, 'window.__harness.summary()');
    check('回放复现出完全相同的表单数据', replayed === recorded, `${replayed}  (录制时: ${recorded})`);

    log('\n回放明细：');
    for (const entry of replayLog) {
      const via = entry.via ? `${entry.via.kind}: ${entry.via.value}` : entry.error || '';
      log(`  ${entry.ok ? '✓' : '✗'} #${String(entry.index).padStart(2)} ${entry.type.padEnd(7)} ${via}`);
    }
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    server.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  log(`\n===== ${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('E2E 异常终止：', error);
  process.exit(1);
});

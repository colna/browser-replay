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

/** 真实键盘输入（一次性插入，等价于 IME 提交 / 粘贴，不产生逐个 keydown） */
async function realType(cdp, sessionId, text) {
  await cdp.send('Input.insertText', { text }, sessionId);
  await sleep(150);
}

/** 真实逐键输入：每个字符发一对 keyDown(带 text)/keyUp，产生真正的 keydown 事件 */
async function realKeyType(cdp, sessionId, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
    await sleep(20);
  }
}

/** 真实敲一个功能键（退格 / 方向等） */
async function realKey(cdp, sessionId, key, code, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await sleep(20);
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

    // 点一下 SPA 风格的导航容器（带 tabindex，会真的拿到焦点）
    await realClick(cdp, sessionId, '.css-navwrap-2k3l');

    // 点按钮内部最深的那层 span —— 事件 target 是 span，但意图是点按钮
    await realClick(cdp, sessionId, '.css-label-w2');

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

    // 布局容器的 focus 只能退到长结构路径，是脚本里最先失效的部分，不该被录进来
    const focusTags = steps.filter((s) => s.type === 'focus' || s.type === 'blur').map((s) => s.target.tag);
    check(
      '布局容器的聚焦未被录制',
      focusTags.every((tag) => ['input', 'textarea', 'select'].includes(tag)),
      `聚焦步骤的目标标签：${[...new Set(focusTags)].join(', ')}`
    );
    // 点按钮里的 span，应当录成「点这个按钮」而不是 span 的多层结构路径
    const favStep = steps.find((s) => s.target && s.target.hints && /收藏/.test(s.target.hints.text || ''));
    check(
      '点按钮内嵌 span 时上溯到按钮本身',
      favStep && favStep.target.tag === 'button' && favStep.target.candidates[0].value === 'button[aria-label="收藏此项"]',
      favStep ? `${favStep.target.tag} → ${favStep.target.candidates[0].value}` : '(没找到该步骤)'
    );

    // 结构路径应当从最近的地标 / 锚点起算，而不是从 html > body 一路铺下来
    const paths = steps
      .map((s) => s.target && s.target.candidates[0].value)
      .filter((v) => v && v.includes('>'));
    check(
      '结构路径不从 html/body 起算',
      paths.every((v) => !/^html|^body/.test(v)),
      paths.join(' | ') || '(无结构路径)'
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

    // ---------- 失效步骤的处理 ----------
    // 造一个目标已不存在的步骤（页面改版后的常态），验证：
    // 可选步骤跳过继续、关键步骤中断，且错误信息说得清原因
    const ghost = (type) => ({
      type,
      timeoutMs: 600,
      target: {
        candidates: [{ kind: 'id', value: '#元素已不存在', score: 92 }],
        hints: {},
        shadowPath: [],
        tag: 'div'
      }
    });

    await evaluate(cdp, sessionId, 'window.__harness.reset()');
    const withGhostFocus = await evaluate(
      cdp,
      sessionId,
      `window.__harness.replay(${JSON.stringify([ghost('focus'), ...steps])})`
    );
    check(
      '失效的聚焦步骤被跳过而非中断',
      withGhostFocus[0].skipped === true && withGhostFocus.length === steps.length + 1,
      `第 1 步 skipped=${withGhostFocus[0].skipped}，共执行 ${withGhostFocus.length} 步`
    );
    check(
      '跳过失效聚焦后仍完整复现表单',
      (await evaluate(cdp, sessionId, 'window.__harness.summary()')) === recorded
    );

    await evaluate(cdp, sessionId, 'window.__harness.reset()');
    const withGhostClick = await evaluate(
      cdp,
      sessionId,
      `window.__harness.replay(${JSON.stringify([ghost('click'), ...steps])})`
    );
    check(
      '失效的点击步骤中断回放',
      withGhostClick.length === 1 && withGhostClick[0].ok === false,
      `执行了 ${withGhostClick.length} 步`
    );
    check(
      '错误信息指出了「找不到元素」并附上尝试过的选择器',
      /找不到该元素/.test(withGhostClick[0].error) && /0 个匹配/.test(withGhostClick[0].error),
      withGhostClick[0].error
    );

    // ---------- 自绘编辑器（Snapchat / Lexical 同构） ----------
    // 独立录一段，不并进上面那轮，避免动到已有断言的步骤序列
    log('\n── 自绘编辑器 ──');
    await evaluate(cdp, sessionId, 'window.__harness.reset(); window.__harness.resetChat(); window.__harness.clearSteps()');
    await evaluate(cdp, sessionId, 'window.__harness.startRecord()');
    await sleep(200);

    await realClick(cdp, sessionId, '[placeholder="Send a chat"]');
    await realType(cdp, sessionId, 'hi');
    await realClick(cdp, sessionId, '.css-sendicon-4q'); // 点的是 svg，意图是点它外面的按钮
    await sleep(150);
    await realClick(cdp, sessionId, '[placeholder="Send a chat"]');
    await realType(cdp, sessionId, 'hello');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await sleep(200);

    const chatRecorded = await evaluate(cdp, sessionId, 'window.__harness.chatLog()');
    check('录制阶段两条消息确实发出去了', chatRecorded === 'hi|hello', chatRecorded);

    const chatSteps = await evaluate(cdp, sessionId, 'window.__harness.stopRecord()');
    const chatInputs = chatSteps.filter((s) => s.type === 'input');
    check(
      '自绘编辑器的输入被录进来了',
      chatInputs.length === 2 && chatInputs[0].value === 'hi' && chatInputs[1].value === 'hello',
      chatInputs.length ? chatInputs.map((s) => JSON.stringify(s.value)).join(' | ') : '(一条 input 步骤都没有)'
    );

    const svgStep = chatSteps.find((s) => s.type === 'click' && s.target && s.target.tag === 'svg');
    check(
      '点发送图标时上溯到按钮而非停在 svg',
      !svgStep,
      svgStep ? `停在了 svg：${svgStep.target.candidates[0].value}` : ''
    );

    const chatScrolls = chatSteps.filter((s) => s.type === 'scroll');
    check(
      '没有录进原地不动的滚动',
      chatScrolls.length === 0,
      chatScrolls.map((s) => `(${s.scrollX},${s.scrollY})`).join(' ')
    );

    await evaluate(cdp, sessionId, 'window.__harness.resetChat()');
    const chatReplayLog = await evaluate(cdp, sessionId, `window.__harness.replay(${JSON.stringify(chatSteps)})`);
    const chatFailed = chatReplayLog.filter((entry) => !entry.ok && !entry.skipped);
    check(
      '回放自绘编辑器全部步骤成功',
      chatFailed.length === 0,
      chatFailed.map((f) => `#${f.index} ${f.type}: ${f.error}`).join('; ')
    );

    const chatReplayed = await evaluate(cdp, sessionId, 'window.__harness.chatLog()');
    check('回放发出的消息与录制时逐字一致', chatReplayed === chatRecorded, `${chatReplayed}  (录制时: ${chatRecorded})`);

    // ---------- 逐键录制 / 回放 ----------
    // 用真实逐个 keydown 打字 + 退格，验证：普通文本框逐键成 keystroke 步骤、无冗余值快照、回放逐键复现
    log('\n── 逐键录制 / 回放 ──');
    await evaluate(cdp, sessionId, 'window.__harness.reset(); window.__harness.clearSteps()');
    await evaluate(cdp, sessionId, 'window.__harness.startRecord()');
    await sleep(200);

    await realClick(cdp, sessionId, '#nickname');
    await realKeyType(cdp, sessionId, 'Codex');
    await realKey(cdp, sessionId, 'Backspace', 'Backspace', 8); // Codex → Code
    await realKeyType(cdp, sessionId, 'r'); // Code → Coder
    await realClick(cdp, sessionId, '#remark'); // 失焦结算
    await sleep(150);

    const keyRecorded = await evaluate(cdp, sessionId, 'document.getElementById("nickname").value');
    check('逐键录制阶段输入框内容正确', keyRecorded === 'Coder', keyRecorded);

    const keySteps = await evaluate(cdp, sessionId, 'window.__harness.stopRecord()');
    const keystrokeSteps = keySteps.filter((s) => s.type === 'keystroke');
    check(
      '普通文本框被逐键录制',
      keystrokeSteps.length === 7, // C o d e x  Backspace  r
      `${keystrokeSteps.length} 个 keystroke：${keystrokeSteps.map((s) => s.char || s.key).join(' ')}`
    );
    check(
      '退格键作为编辑键被录进来',
      keystrokeSteps.some((s) => s.key === 'Backspace'),
      keystrokeSteps.map((s) => s.key).join(' ')
    );
    // 内容全由键盘产生 → blur 不该再补一步冗余的值快照
    const nickInputSteps = keySteps.filter((s) => s.type === 'input' && s.target && s.target.tag === 'input');
    check(
      '逐键内容不再重复记成值快照',
      nickInputSteps.length === 0,
      `多出 ${nickInputSteps.length} 步 input`
    );

    await evaluate(cdp, sessionId, 'window.__harness.reset()');
    const keyReplayLog = await evaluate(cdp, sessionId, `window.__harness.replay(${JSON.stringify(keySteps)})`);
    const keyFailed = keyReplayLog.filter((entry) => !entry.ok && !entry.skipped);
    check(
      '逐键回放全部步骤成功',
      keyFailed.length === 0,
      keyFailed.map((f) => `#${f.index} ${f.type}: ${f.error}`).join('; ')
    );
    const keyReplayed = await evaluate(cdp, sessionId, 'document.getElementById("nickname").value');
    check('逐键回放复现出相同内容（含退格效果）', keyReplayed === 'Coder', keyReplayed);

    // ---------- 无标识编辑器 + 输入事件被吞（Instagram DM 实测形态） ----------
    log('\n── 无标识编辑器 / 输入事件被吞 ──');
    const igSelector = '[aria-placeholder="发消息..."]';
    await evaluate(cdp, sessionId, 'window.__harness.resetIg(); window.__harness.clearSteps()');
    // 编辑区在页面底部，先滚进视口再开录 —— 否则点击坐标落在视口外，点不到它
    await evaluate(cdp, sessionId, `document.querySelector('${igSelector}').scrollIntoView({ block: 'center' })`);
    await sleep(150);
    await evaluate(cdp, sessionId, 'window.__harness.startRecord()');
    await sleep(200);

    await realClick(cdp, sessionId, igSelector);
    await realKeyType(cdp, sessionId, 'hello');
    await realKey(cdp, sessionId, 'Enter', 'Enter', 13);
    await sleep(200);

    const igRecorded = await evaluate(cdp, sessionId, 'window.__harness.igLog()');
    check('录制阶段消息确实发出去了', igRecorded === 'hello', igRecorded);

    const igSteps = await evaluate(cdp, sessionId, 'window.__harness.stopRecord()');
    const igInputs = igSteps.filter((s) => s.type === 'input');
    check(
      '输入事件被吞掉时仍靠 keydown 录到了输入',
      igInputs.length === 1 && igInputs[0].value === 'hello',
      igInputs.length ? igInputs.map((s) => JSON.stringify(s.value)).join(' | ') : '(一条 input 步骤都没有)'
    );

    // 候选归零会让回放连「已尝试了哪些选择器」都打印不出来，用户完全无从判断
    const emptyCandidateSteps = igSteps.filter((s) => s.target && (s.target.candidates || []).length === 0);
    check(
      '无标识元素也至少留下一条候选',
      emptyCandidateSteps.length === 0,
      `${emptyCandidateSteps.length} 步零候选：${emptyCandidateSteps.map((s) => s.type).join(', ')}`
    );

    await evaluate(cdp, sessionId, 'window.__harness.resetIg()');
    const igReplayLog = await evaluate(cdp, sessionId, `window.__harness.replay(${JSON.stringify(igSteps)})`);
    const igFailed = igReplayLog.filter((entry) => !entry.ok && !entry.skipped);
    check(
      '回放无标识编辑器全部步骤成功',
      igFailed.length === 0,
      igFailed.map((f) => `#${f.index} ${f.type}: ${f.error}`).join('; ')
    );
    const igReplayed = await evaluate(cdp, sessionId, 'window.__harness.igLog()');
    check('回放发出的消息与录制时一致（不是空消息）', igReplayed === igRecorded, `${igReplayed}  (录制时: ${igRecorded})`);

    // 编辑区身上只有 aria-placeholder / role / contenteditable 这类属性，
    // 它们进白名单前只能退到结构路径 —— 现在应当直接命中语义候选
    const igEditorStep = igSteps.find((s) => s.type === 'input');
    const igEditorBest = igEditorStep && igEditorStep.target.candidates[0];
    check(
      '自绘编辑区拿到了语义候选而非结构路径',
      igEditorBest && igEditorBest.score >= 55,
      igEditorBest ? `${igEditorBest.kind} · ${igEditorBest.score} · ${igEditorBest.value}` : '(无候选)'
    );

    // 兜底本身也要守住：目标一个候选都不剩时，按键仍应打到当前焦点元素上
    await evaluate(cdp, sessionId, 'window.__harness.resetIg()');
    const blindKey = {
      type: 'key',
      key: 'Enter',
      code: 'Enter',
      timeoutMs: 600,
      target: { candidates: [], hints: {}, shadowPath: [], tag: 'div' }
    };
    const blindSteps = [igSteps.find((s) => s.type === 'focus'), igEditorStep, blindKey].filter(Boolean);
    const blindLog = await evaluate(cdp, sessionId, `window.__harness.replay(${JSON.stringify(blindSteps)})`);
    const blindVia = blindLog[blindLog.length - 1].via;
    check(
      '零候选的按键步骤退到了当前焦点元素',
      blindVia && blindVia.kind === 'activeElement',
      blindLog.map((e) => `${e.type}:${e.via ? e.via.kind : '-'}`).join(' ')
    );
    const blindSent = await evaluate(cdp, sessionId, 'window.__harness.igLog()');
    check('零候选兜底后消息照样发得出去', blindSent === 'hello', blindSent);

    // ---------- 站点恢复草稿：录制开始前编辑区里就有内容 ----------
    // Instagram DM 会恢复草稿。以聚焦那刻的内容为基线，就等于认定「这不用记」——
    // 录出来一条 input 都没有、每步都显示成功，回放时却在空输入框上点发送。
    log('\n── 编辑区预存草稿 ──');
    await evaluate(cdp, sessionId, 'window.__harness.seedIgDraft("666"); window.__harness.clearSteps()');
    await evaluate(cdp, sessionId, 'window.__harness.startRecord()');
    await sleep(200);

    await realClick(cdp, sessionId, igSelector); // 聚焦，但一个字都不打
    await realClick(cdp, sessionId, '[aria-label="发送"]');
    await sleep(200);

    const draftSent = await evaluate(cdp, sessionId, 'window.__harness.igLog()');
    check('录制阶段草稿确实被发出去了', draftSent === '666', draftSent);

    const draftSteps = await evaluate(cdp, sessionId, 'window.__harness.stopRecord()');
    const draftInputs = draftSteps.filter((s) => s.type === 'input');
    check(
      '聚焦前就存在的内容也被录进来了',
      draftInputs.length === 1 && draftInputs[0].value === '666',
      draftInputs.length ? draftInputs.map((s) => JSON.stringify(s.value)).join(' | ') : '(一条 input 步骤都没有)'
    );

    await evaluate(cdp, sessionId, 'window.__harness.resetIg()'); // 回放从空编辑区开始
    const draftLog = await evaluate(cdp, sessionId, `window.__harness.replay(${JSON.stringify(draftSteps)})`);
    const draftFailed = draftLog.filter((entry) => !entry.ok && !entry.skipped);
    check(
      '回放预存草稿场景全部步骤成功',
      draftFailed.length === 0,
      draftFailed.map((f) => `#${f.index} ${f.type}: ${f.error}`).join('; ')
    );
    const draftReplayed = await evaluate(cdp, sessionId, 'window.__harness.igLog()');
    check('空编辑区回放也发得出同样的消息', draftReplayed === '666', `${draftReplayed}  (录制时: ${draftSent})`);

    // ---------- 同一位置换了个按钮：必须失败，不能点下去 ----------
    // Instagram 的发送按钮在输入框为空时原地变成麦克风。语义候选匹配不上后退到结构路径，
    // 按位置就命中了麦克风 —— 实测把「回放」变成了「开始录音」。
    // 找不到只是这一步失败；点错却是执行了另一个动作，代价高得多。
    log('\n── 同位置异按钮（发送 → 麦克风） ──');
    await evaluate(cdp, sessionId, 'window.__harness.resetIg(); window.__harness.swapIgSendToMic()');

    const sendStep = draftSteps.find((s) => s.type === 'click' && s.target && s.target.hints && s.target.hints.ariaLabel === '发送');
    check('取到了录制时的发送按钮步骤', !!sendStep, sendStep ? sendStep.target.candidates[0].value : '(没找到)');

    // 只保留「已失效的语义候选 + 仍能按位置命中的结构路径」，还原线上那一刻的候选状态
    const misfire = {
      ...sendStep,
      timeoutMs: 600,
      target: {
        ...sendStep.target,
        candidates: [
          { kind: 'aria', value: 'div[aria-label="发送"]', score: 80 },
          { kind: 'structural', value: '#ig-root [role="button"]', score: 40 }
        ]
      }
    };
    const misfireLog = await evaluate(cdp, sessionId, `window.__harness.replay(${JSON.stringify([misfire])})`);
    check(
      '语义对不上时不拿结构路径硬点',
      !misfireLog[0].ok,
      misfireLog[0].ok ? `点到了 ${misfireLog[0].via && misfireLog[0].via.value}` : misfireLog[0].error
    );
    const micLog = await evaluate(cdp, sessionId, 'window.__harness.igLog()');
    check('没有误触发录音', micLog !== '录音中', micLog);

    // ---------- 旧 content script 必须能被新版本顶掉 ----------
    // 扩展重新加载后，已打开的标签页里还留着旧实例。哨兵若是布尔量，覆盖注入进来的新代码
    // 会一行都不跑就 return —— 页面永远停在旧版本，而且从外部完全看不出来：
    // 改了代码、重载了扩展、现象纹丝不动，只会让人以为修错了地方。
    log('\n── content script 版本接管 ──');
    const takeover = await evaluate(
      cdp,
      sessionId,
      `(async () => {
        window.__BR_CONTENT__ = 'stale-0.0.1';
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/src/content.js?reinject=1';
          s.onload = resolve;
          s.onerror = reject;
          document.body.appendChild(s);
        });
        return window.__BR_CONTENT__;
      })()`
    );
    check('旧版本的 content script 会被新注入顶掉', takeover !== 'stale-0.0.1', `注入后哨兵 = ${takeover}`);

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

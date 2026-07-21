/**
 * 跑全部测试：选择器单元测试（headless Chrome 里跑真实 DOM）+ 录制回放端到端。
 * 两套都需要本机 Chrome，没有 npm 依赖。
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const selectorOnly = process.argv.includes('--selector-only');

function runSelectorTests() {
  console.log('── 选择器单元测试 ──');
  const url = `file://${path.join(__dirname, 'selector-test.html')}`;
  const dom = execFileSync(
    CHROME,
    ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--virtual-time-budget=3000', '--dump-dom', url],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10 * 1024 * 1024 }
  );
  const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.error('拿不到测试结果');
    return 1;
  }
  const text = match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
  console.log(text);
  return /0 failed/.test(text) ? 0 : 1;
}

function runE2E() {
  console.log('\n── 录制 / 回放端到端 ──');
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, 'e2e.mjs')], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code || 0));
  });
}

const selectorCode = runSelectorTests();
const e2eCode = selectorOnly ? 0 : await runE2E();
process.exit(selectorCode || e2eCode);

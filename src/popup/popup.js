const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  recordBtn: $('recordBtn'),
  stopReplayBtn: $('stopReplayBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  progressBox: $('progressBox'),
  progressLabel: $('progressLabel'),
  progressCount: $('progressCount'),
  progressFill: $('progressFill'),
  progressError: $('progressError'),
  listView: $('listView'),
  detailView: $('detailView'),
  emptyHint: $('emptyHint'),
  scriptList: $('scriptList'),
  backBtn: $('backBtn'),
  detailName: $('detailName'),
  stepList: $('stepList'),
  copyJsonBtn: $('copyJsonBtn'),
  downloadJsonBtn: $('downloadJsonBtn'),
  toast: $('toast')
};

let state = { scripts: [], rec: null, play: null };
let detailScriptId = null;
let toastTimer = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 1800);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

// ------------------------------------------------------------------ 渲染

function renderStatus() {
  const { rec, play } = state;
  els.statusDot.className = 'brand-dot';
  els.stopReplayBtn.hidden = true;

  if (rec && rec.recording) {
    els.statusDot.classList.add('rec');
    els.statusText.textContent = '正在录制';
    els.recordBtn.textContent = '停止录制';
    els.recordBtn.classList.add('recording');
  } else {
    els.statusText.textContent = '就绪';
    els.recordBtn.textContent = '开始录制';
    els.recordBtn.classList.remove('recording');
  }

  if (play && play.status === 'running') {
    els.statusDot.classList.add('play');
    els.statusText.textContent = `回放中 · ${play.scriptName || ''}`;
    els.stopReplayBtn.hidden = false;
  }

  renderProgress();
}

function renderProgress() {
  const play = state.play;
  if (!play || play.status === 'idle') {
    els.progressBox.hidden = true;
    return;
  }
  els.progressBox.hidden = false;

  const labels = { running: '回放中', done: '回放完成', failed: '回放失败', stopped: '已停止' };
  const skipped = play.skippedCount ? `（跳过 ${play.skippedCount} 步聚焦/滚动）` : '';
  els.progressLabel.textContent = (labels[play.status] || play.status) + skipped;
  els.progressCount.textContent = `${play.cursor || 0} / ${play.total || 0}`;

  const pct = play.total ? Math.round(((play.cursor || 0) / play.total) * 100) : 0;
  els.progressFill.style.width = `${pct}%`;
  els.progressFill.classList.toggle('failed', play.status === 'failed');

  if (play.status === 'failed' && play.error) {
    els.progressError.hidden = false;
    els.progressError.textContent = `第 ${(play.cursor || 0) + 1} 步：${play.error}`;
  } else {
    els.progressError.hidden = true;
  }
}

function renderList() {
  els.scriptList.innerHTML = '';
  els.emptyHint.hidden = state.scripts.length > 0;

  for (const script of state.scripts) {
    const li = document.createElement('li');
    li.className = 'script';
    li.innerHTML = `
      <div class="script-title">
        <span class="script-name"></span>
        <span class="script-meta">${script.steps.length} 步 · ${timeAgo(script.updatedAt)}</span>
      </div>
      <div class="script-url"></div>
      <div class="script-actions">
        <button class="ghost" data-act="replay">回放</button>
        <button class="ghost" data-act="detail">步骤</button>
        <button class="ghost" data-act="rename">重命名</button>
        <button class="ghost" data-act="delete">删除</button>
      </div>
    `;
    li.querySelector('.script-name').textContent = script.name;
    li.querySelector('.script-url').textContent = script.startUrl || '';

    li.addEventListener('click', async (event) => {
      const act = event.target.dataset && event.target.dataset.act;
      if (!act) return;

      if (act === 'replay') {
        const tab = await activeTab();
        await send({ type: 'BR_REPLAY', scriptId: script.id, tabId: tab.id });
        toast('开始回放');
        setTimeout(refresh, 300);
      } else if (act === 'detail') {
        openDetail(script.id);
      } else if (act === 'rename') {
        const name = prompt('新名称', script.name);
        if (name) {
          await send({ type: 'BR_RENAME', scriptId: script.id, name });
          refresh();
        }
      } else if (act === 'delete') {
        if (confirm(`删除「${script.name}」？`)) {
          await send({ type: 'BR_DELETE', scriptId: script.id });
          refresh();
        }
      }
    });

    els.scriptList.appendChild(li);
  }
}

const TYPE_LABEL = {
  navigate: '打开',
  click: '点击',
  input: '输入',
  select: '选择',
  check: '勾选',
  focus: '聚焦',
  blur: '失焦',
  key: '按键',
  submit: '提交',
  scroll: '滚动'
};

function renderSteps(script) {
  els.detailName.textContent = script.name;
  els.stepList.innerHTML = '';

  script.steps.forEach((step, index) => {
    const li = document.createElement('li');
    li.className = 'step';

    const best = step.target && step.target.candidates && step.target.candidates[0];
    const selector = step.type === 'navigate' ? step.url : best ? best.value : '（无选择器）';

    li.innerHTML = `
      <span class="step-idx">${index + 1}</span>
      <div class="step-body">
        <span class="step-type"></span>
        <span class="step-score"></span>
        <p class="step-sel"></p>
        <p class="step-val" hidden></p>
      </div>
      <button class="step-del" title="删除该步">✕</button>
    `;
    li.querySelector('.step-type').textContent = TYPE_LABEL[step.type] || step.type;
    li.querySelector('.step-score').textContent = best ? ` ${best.kind} · ${best.score}` : '';
    li.querySelector('.step-sel').textContent = selector;

    const valueEl = li.querySelector('.step-val');
    if (step.masked) {
      valueEl.hidden = false;
      valueEl.textContent = '值：（敏感输入未录制）';
    } else if (step.value !== undefined) {
      valueEl.hidden = false;
      valueEl.textContent = `值：${step.value}`;
    } else if (step.checked !== undefined) {
      valueEl.hidden = false;
      valueEl.textContent = `勾选：${step.checked}`;
    } else if (step.key) {
      valueEl.hidden = false;
      valueEl.textContent = `按键：${step.key}`;
    }

    li.querySelector('.step-del').addEventListener('click', async () => {
      const res = await send({ type: 'BR_DELETE_STEP', scriptId: script.id, index });
      if (res.ok) renderSteps(res.script);
    });

    els.stepList.appendChild(li);
  });
}

async function openDetail(scriptId) {
  detailScriptId = scriptId;
  const res = await send({ type: 'BR_GET', scriptId });
  if (!res.ok || !res.script) return;
  els.listView.hidden = true;
  els.detailView.hidden = false;
  renderSteps(res.script);
}

function closeDetail() {
  detailScriptId = null;
  els.detailView.hidden = true;
  els.listView.hidden = false;
}

// ------------------------------------------------------------------ 交互

els.recordBtn.addEventListener('click', async () => {
  if (state.rec && state.rec.recording) {
    const res = await send({ type: 'BR_STOP' });
    toast(res.script ? `已保存 ${res.script.steps.length} 步` : '已停止');
  } else {
    const tab = await activeTab();
    if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      toast('浏览器内部页面无法录制');
      return;
    }
    await send({ type: 'BR_START', tabId: tab.id });
    toast('开始录制，去页面上操作吧');
  }
  refresh();
});

els.stopReplayBtn.addEventListener('click', async () => {
  await send({ type: 'BR_STOP_REPLAY' });
  refresh();
});

els.backBtn.addEventListener('click', closeDetail);

els.copyJsonBtn.addEventListener('click', async () => {
  const res = await send({ type: 'BR_EXPORT', scriptId: detailScriptId });
  if (!res.ok) return;
  await navigator.clipboard.writeText(JSON.stringify(res.data, null, 2));
  toast('JSON 已复制');
});

els.downloadJsonBtn.addEventListener('click', async () => {
  const res = await send({ type: 'BR_EXPORT', scriptId: detailScriptId });
  if (!res.ok) return;
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(res.data.name || 'script').replace(/[^\w一-龥-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已下载');
});

els.importBtn.addEventListener('click', () => els.importFile.click());

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await send({ type: 'BR_IMPORT', data });
    toast(res.ok ? '导入成功' : res.error || '导入失败');
  } catch (error) {
    toast('JSON 解析失败');
  }
  els.importFile.value = '';
  refresh();
});

// ------------------------------------------------------------------ 刷新

async function refresh() {
  const res = await send({ type: 'BR_LIST' });
  if (!res || !res.ok) return;
  state = res;
  renderStatus();
  if (!detailScriptId) renderList();
}

// 回放进度写在 session storage 里，直接监听变化，不做无谓轮询
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.playState || changes.recState) refresh();
});

refresh();

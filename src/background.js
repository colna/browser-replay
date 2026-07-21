/**
 * Service worker：录制会话与回放游标的唯一权威。
 *
 * MV3 的 service worker 随时可能被回收，所以**任何跨消息存活的状态都必须落存储**，
 * 内存变量只当缓存用。这是 MV3 扩展最常见的翻车点：本机测好好的，
 * 闲置半分钟后回放就断在半路。
 */

import { toExport } from './lib/export.js';

const CONTENT_FILES = [
  'src/lib/selector.js',
  'src/lib/waiter.js',
  'src/lib/executor.js',
  'src/content.js'
];

const KEY_SCRIPTS = 'scripts';
const KEY_ORDER = 'scriptOrder';
const KEY_REC = 'recState';
const KEY_PLAY = 'playState';

// ---------------------------------------------------------------- 存储封装

async function getScripts() {
  const data = await chrome.storage.local.get([KEY_SCRIPTS, KEY_ORDER]);
  return { scripts: data[KEY_SCRIPTS] || {}, order: data[KEY_ORDER] || [] };
}

async function saveScript(script) {
  const { scripts, order } = await getScripts();
  scripts[script.id] = script;
  const nextOrder = order.includes(script.id) ? order : [script.id, ...order];
  await chrome.storage.local.set({ [KEY_SCRIPTS]: scripts, [KEY_ORDER]: nextOrder });
}

async function getScript(id) {
  const { scripts } = await getScripts();
  return scripts[id] || null;
}

async function deleteScript(id) {
  const { scripts, order } = await getScripts();
  delete scripts[id];
  await chrome.storage.local.set({
    [KEY_SCRIPTS]: scripts,
    [KEY_ORDER]: order.filter((x) => x !== id)
  });
}

async function getRecState() {
  return (await chrome.storage.session.get(KEY_REC))[KEY_REC] || null;
}

async function setRecState(state) {
  if (state) await chrome.storage.session.set({ [KEY_REC]: state });
  else await chrome.storage.session.remove(KEY_REC);
}

async function getPlayState() {
  return (await chrome.storage.session.get(KEY_PLAY))[KEY_PLAY] || null;
}

async function setPlayState(state) {
  if (state) await chrome.storage.session.set({ [KEY_PLAY]: state });
  else await chrome.storage.session.remove(KEY_PLAY);
}

async function patchPlayState(patch) {
  const current = (await getPlayState()) || {};
  const next = { ...current, ...patch };
  await setPlayState(next);
  return next;
}

// ---------------------------------------------------------------- 注入

async function ensureInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'BR_PING' });
    if (pong && pong.ok) return true;
  } catch {
    /* 插件安装前就打开的标签页没有 content script，下面补注入 */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES
    });
    return true;
  } catch (error) {
    console.warn('[browser-replay] 注入失败', error);
    return false;
  }
}

async function broadcast(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* 页面可能正在跳转，忽略 */
  }
}

// ---------------------------------------------------------------- 录制

function newScriptId() {
  return `br_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function startRecording(tabId, name) {
  const tab = await chrome.tabs.get(tabId);
  const script = {
    id: newScriptId(),
    name: name || `录制 ${new Date().toLocaleString('zh-CN')}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startUrl: tab.url,
    steps: [{ type: 'navigate', url: tab.url, at: Date.now(), sinceLastMs: 0 }]
  };
  await saveScript(script);
  await setRecState({ recording: true, tabId, scriptId: script.id });
  await ensureInjected(tabId);
  await broadcast(tabId, { type: 'BR_START_RECORD' });
  await updateBadge();
  return script;
}

async function stopRecording() {
  const rec = await getRecState();
  if (!rec) return null;
  await broadcast(rec.tabId, { type: 'BR_STOP_RECORD' });
  await setRecState(null);
  await updateBadge();
  return await getScript(rec.scriptId);
}

async function appendStep(scriptId, step) {
  const script = await getScript(scriptId);
  if (!script) return;
  script.steps.push(step);
  script.updatedAt = Date.now();
  await saveScript(script);
}

// 导航必须由 background 记录：content script 的 beforeunload 常常来不及把消息发出去
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const rec = await getRecState();
  if (!rec || rec.tabId !== details.tabId) return;

  const play = await getPlayState();
  if (play && play.status === 'running') return; // 回放触发的跳转不该被录进去

  const script = await getScript(rec.scriptId);
  if (!script) return;
  const last = script.steps[script.steps.length - 1];
  if (last && last.type === 'navigate' && last.url === details.url) return;

  await appendStep(rec.scriptId, {
    type: 'navigate',
    url: details.url,
    transition: details.transitionType,
    at: Date.now()
  });
});

// 页面重载后 content script 是全新的，要重新告诉它「还在录制」
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const rec = await getRecState();
  if (rec && rec.tabId === details.tabId) {
    await broadcast(details.tabId, { type: 'BR_START_RECORD' });
  }
});

// ---------------------------------------------------------------- 回放

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitTabComplete(tabId, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('目标标签页已关闭');
    }
    if (tab.status === 'complete') return tab;
    await sleep(150);
  }
  throw new Error('页面加载超时');
}

/**
 * navigate 步骤：上一步的点击很可能已经把页面带过去了。
 * 先给它一点时间自己到达，没到才主动 update —— 否则会把已经填好的表单页刷掉。
 */
async function runNavigate(tabId, step) {
  const target = step.url;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url === target) {
      await waitTabComplete(tabId);
      return { ok: true, via: { kind: 'auto', value: '页面已自行到达目标 URL' } };
    }
    await sleep(200);
  }
  await chrome.tabs.update(tabId, { url: target });
  await sleep(300);
  await waitTabComplete(tabId);
  await ensureInjected(tabId);
  return { ok: true, via: { kind: 'navigate', value: target } };
}

async function runStep(tabId, step, index, total) {
  if (step.type === 'navigate') return runNavigate(tabId, step);

  await waitTabComplete(tabId);
  await ensureInjected(tabId);

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'BR_EXEC_STEP',
      step,
      index,
      total
    });
    return result || { ok: false, error: '页面无响应' };
  } catch (error) {
    // 消息通道断开：这一步多半触发了页面跳转，content script 已随旧页面销毁。
    // 此时动作其实已经生效，等新页面加载完继续即可。
    const message = String(error && error.message);
    if (/message port closed|Receiving end does not exist|context invalidated/i.test(message)) {
      await sleep(400);
      await waitTabComplete(tabId);
      return { ok: true, via: { kind: 'navigated', value: '该步触发了页面跳转' } };
    }
    return { ok: false, error: message };
  }
}

async function runReplay({ scriptId, tabId, fromIndex = 0, stepDelayMs = 300 }) {
  const script = await getScript(scriptId);
  if (!script) throw new Error('脚本不存在');

  await setPlayState({
    status: 'running',
    scriptId,
    scriptName: script.name,
    tabId,
    cursor: fromIndex,
    total: script.steps.length,
    startedAt: Date.now(),
    log: []
  });
  await updateBadge();

  for (let i = fromIndex; i < script.steps.length; i += 1) {
    const current = await getPlayState();
    if (!current || current.status === 'stopped') {
      await patchPlayState({ status: 'stopped', finishedAt: Date.now() });
      await updateBadge();
      return;
    }

    const step = script.steps[i];
    let result;
    try {
      result = await runStep(tabId, step, i, script.steps.length);
    } catch (error) {
      result = { ok: false, error: String(error && error.message ? error.message : error) };
    }

    const log = (current.log || []).concat([
      {
        index: i,
        type: step.type,
        ok: !!result.ok,
        via: result.via ? `${result.via.kind}: ${result.via.value}` : null,
        error: result.ok ? null : result.error
      }
    ]);

    if (!result.ok) {
      // 失败即停：继续往下跑只会在错误的页面状态上制造更多噪声，
      // 让用户看到「卡在第几步、为什么」远比跑完一堆失败步骤有用。
      await patchPlayState({ status: 'failed', cursor: i, log, error: result.error, finishedAt: Date.now() });
      await updateBadge();
      await broadcast(tabId, { type: 'BR_REPLAY_DONE' });
      return;
    }

    await patchPlayState({ cursor: i + 1, log });
    if (stepDelayMs) await sleep(stepDelayMs);
  }

  await patchPlayState({ status: 'done', finishedAt: Date.now() });
  await updateBadge();
  await broadcast(tabId, { type: 'BR_REPLAY_DONE' });
}

// ---------------------------------------------------------------- 导出

// ---------------------------------------------------------------- 徽标

async function updateBadge() {
  const rec = await getRecState();
  const play = await getPlayState();
  if (rec && rec.recording) {
    await chrome.action.setBadgeText({ text: 'REC' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ff453a' });
    return;
  }
  if (play && play.status === 'running') {
    await chrome.action.setBadgeText({ text: '▶' });
    await chrome.action.setBadgeBackgroundColor({ color: '#30d158' });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
}

// ---------------------------------------------------------------- 消息路由

const HANDLERS = {
  async BR_STEP(message, sender) {
    const rec = await getRecState();
    if (!rec || !rec.recording) return { ok: false };
    if (sender.tab && sender.tab.id !== rec.tabId) return { ok: false };
    const step = { ...message.step };
    if (sender.frameId) step.frameId = sender.frameId;
    await appendStep(rec.scriptId, step);
    return { ok: true };
  },

  async BR_FRAME_READY(_message, sender) {
    const rec = await getRecState();
    if (rec && sender.tab && sender.tab.id === rec.tabId) {
      return { ok: true, record: true };
    }
    return { ok: true };
  },

  async BR_START(message) {
    const script = await startRecording(message.tabId, message.name);
    return { ok: true, script };
  },

  async BR_STOP() {
    const script = await stopRecording();
    return { ok: true, script };
  },

  async BR_REPLAY(message) {
    // 不 await：回放是长流程，先把控制权还给 popup，进度通过 storage 轮询
    runReplay({
      scriptId: message.scriptId,
      tabId: message.tabId,
      fromIndex: message.fromIndex || 0,
      stepDelayMs: message.stepDelayMs
    }).catch(async (error) => {
      await patchPlayState({ status: 'failed', error: String(error && error.message), finishedAt: Date.now() });
      await updateBadge();
    });
    return { ok: true };
  },

  async BR_STOP_REPLAY() {
    await patchPlayState({ status: 'stopped' });
    await updateBadge();
    return { ok: true };
  },

  async BR_LIST() {
    const { scripts, order } = await getScripts();
    const rec = await getRecState();
    const play = await getPlayState();
    return {
      ok: true,
      scripts: order.map((id) => scripts[id]).filter(Boolean),
      rec,
      play
    };
  },

  async BR_GET(message) {
    return { ok: true, script: await getScript(message.scriptId) };
  },

  async BR_DELETE(message) {
    await deleteScript(message.scriptId);
    return { ok: true };
  },

  async BR_RENAME(message) {
    const script = await getScript(message.scriptId);
    if (!script) return { ok: false };
    script.name = message.name;
    script.updatedAt = Date.now();
    await saveScript(script);
    return { ok: true };
  },

  async BR_DELETE_STEP(message) {
    const script = await getScript(message.scriptId);
    if (!script) return { ok: false };
    script.steps.splice(message.index, 1);
    script.updatedAt = Date.now();
    await saveScript(script);
    return { ok: true, script };
  },

  async BR_EXPORT(message) {
    const script = await getScript(message.scriptId);
    if (!script) return { ok: false };
    return { ok: true, data: toExport(script) };
  },

  async BR_IMPORT(message) {
    const data = message.data;
    if (!data || !Array.isArray(data.steps)) return { ok: false, error: 'JSON 格式不正确' };
    const script = {
      id: newScriptId(),
      name: `${data.name || '导入脚本'}（导入）`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startUrl: data.startUrl || '',
      steps: data.steps
    };
    await saveScript(script);
    return { ok: true, script };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message && message.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
  return true; // 异步响应
});

chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => updateBadge());

/**
 * 页面侧：录制器 + 回放执行器。
 *
 * 这里刻意不持有任何「进度」状态 —— 页面一跳转 content script 就被销毁重建，
 * 谁把游标存在这里，谁就会在跳转后错乱。游标只属于 background。
 */
(() => {
  if (window.__BR_CONTENT__) return;
  window.__BR_CONTENT__ = true;

  const SELECTOR = window.__BR_SELECTOR__;
  const WAITER = window.__BR_WAITER__;
  const EXECUTOR = window.__BR_EXECUTOR__;

  const HUD_ID = '__browser_replay_hud__';
  const isTopFrame = window.top === window;

  let recording = false;
  let lastEventAt = 0;
  /** 未提交的输入（连续按键要合并成一步，否则一行文字会产出几十条记录） */
  let pendingInput = null;
  /** 仅用于「刚才那一步是什么」的去重判断，不是回放进度 —— 进度永远只属于 background */
  let lastEmitted = { type: null, at: 0 };

  // ------------------------------------------------------------------ 工具

  function now() {
    return Date.now();
  }

  function sinceLast() {
    const t = now();
    const delta = lastEventAt ? t - lastEventAt : 0;
    lastEventAt = t;
    return delta;
  }

  /** 插件自己的浮层不能被录进去 */
  function isOwnUI(node) {
    if (!node || !node.closest) return false;
    return !!node.closest(`#${HUD_ID}`);
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* service worker 正在重启，丢一条录制事件比抛错中断页面好 */
    }
  }

  function emit(step) {
    if (!recording) return;
    lastEmitted = { type: step.type, at: now() };
    send({ type: 'BR_STEP', step: { ...step, at: now(), url: location.href } });
  }

  function isSensitive(el) {
    if (el.type === 'password') return true;
    const name = `${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`.toLowerCase();
    return /password|passwd|otp|cvv|card-?number|secret|token/.test(name);
  }

  // ------------------------------------------------------------------ 录制

  function flushPendingInput() {
    if (!pendingInput) return;
    const { target, value, masked } = pendingInput;
    pendingInput = null;
    emit({ type: 'input', target, value, masked, sinceLastMs: sinceLast() });
  }

  function onInput(event) {
    const el = event.target;
    if (!el || isOwnUI(el)) return;
    if (el.tagName === 'SELECT') return; // select 由 change 负责
    // 勾选 checkbox/radio 同样会派发 input，此时 el.value 是 value 属性（如 "yes"、缺省 "on"），
    // 不是用户输入的内容 —— 记下来会变成一步毫无意义的「输入 yes」。状态变化交给 change。
    if (el.type === 'checkbox' || el.type === 'radio') return;
    // file input 的值受安全策略保护，回放时无法写回，录了也只会在回放时报错
    if (el.type === 'file') return;

    const masked = isSensitive(el);
    const value = el.isContentEditable ? el.textContent : el.value;

    // 换了元素就把上一个元素的输入结算掉，保证顺序正确
    if (pendingInput && pendingInput.element !== el) flushPendingInput();

    pendingInput = {
      element: el,
      target: SELECTOR.describe(el),
      value: masked ? '' : value,
      masked
    };
  }

  function onChange(event) {
    const el = event.target;
    if (!el || isOwnUI(el)) return;

    if (el.tagName === 'SELECT') {
      flushPendingInput();
      const option = el.selectedOptions && el.selectedOptions[0];
      emit({
        type: 'select',
        target: SELECTOR.describe(el),
        value: el.value,
        text: option ? option.textContent.trim() : '',
        sinceLastMs: sinceLast()
      });
      return;
    }

    if (el.type === 'checkbox' || el.type === 'radio') {
      flushPendingInput();
      emit({ type: 'check', target: SELECTOR.describe(el), checked: el.checked, sinceLastMs: sinceLast() });
      return;
    }

    flushPendingInput();
  }

  function onClick(event) {
    const el = event.target;
    if (!el || isOwnUI(el)) return;
    // checkbox / radio 的状态变化交给 change，避免同一次操作记两步
    if (el.type === 'checkbox' || el.type === 'radio') return;

    flushPendingInput();
    emit({ type: 'click', target: SELECTOR.describe(el), sinceLastMs: sinceLast() });
  }

  function onFocusIn(event) {
    const el = event.target;
    if (!el || isOwnUI(el) || el === document.body) return;
    emit({ type: 'focus', target: SELECTOR.describe(el), sinceLastMs: sinceLast() });
  }

  function onFocusOut(event) {
    const el = event.target;
    if (!el || isOwnUI(el) || el === document.body) return;
    // 输入必须在失焦前结算，否则回放顺序会变成「先失焦再填值」
    if (pendingInput && pendingInput.element === el) flushPendingInput();
    emit({ type: 'blur', target: SELECTOR.describe(el), sinceLastMs: sinceLast() });
  }

  const FUNCTIONAL_KEYS = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
  ]);

  function onKeyDown(event) {
    const el = event.target;
    if (!el || isOwnUI(el)) return;

    const isCombo = event.ctrlKey || event.metaKey || event.altKey;
    if (!FUNCTIONAL_KEYS.has(event.key) && !isCombo) return; // 普通字符由 input 覆盖

    if (event.key === 'Enter' || event.key === 'Tab') flushPendingInput();

    emit({
      type: 'key',
      target: SELECTOR.describe(el),
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      sinceLastMs: sinceLast()
    });
  }

  function onSubmit(event) {
    const el = event.target;
    if (!el || isOwnUI(el)) return;
    flushPendingInput();

    // 点提交按钮时，submit 是 click 的默认行为，两者会被记成两步。
    // 回放时第一步点击已经把页面带走了，第二步再去找 form 必然失败 —— 这里直接丢掉冗余的那步。
    if (lastEmitted.type === 'click' && now() - lastEmitted.at < 200) return;

    emit({ type: 'submit', target: SELECTOR.describe(el), sinceLastMs: sinceLast() });
  }

  let scrollTimer = null;
  function onScroll() {
    if (!recording) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      emit({ type: 'scroll', scrollX: window.scrollX, scrollY: window.scrollY, sinceLastMs: sinceLast() });
    }, 250);
  }

  const LISTENERS = [
    ['click', onClick],
    ['input', onInput],
    ['change', onChange],
    ['focusin', onFocusIn],
    ['focusout', onFocusOut],
    ['keydown', onKeyDown],
    ['submit', onSubmit],
    ['scroll', onScroll]
  ];

  function startRecording() {
    if (recording) return;
    recording = true;
    lastEventAt = now();
    // 捕获阶段监听：页面自己 stopPropagation 掉的事件在冒泡阶段是收不到的
    for (const [type, handler] of LISTENERS) {
      window.addEventListener(type, handler, true);
    }
    if (isTopFrame) mountHud('recording');
  }

  function stopRecording() {
    if (!recording) return;
    flushPendingInput();
    recording = false;
    for (const [type, handler] of LISTENERS) {
      window.removeEventListener(type, handler, true);
    }
    if (isTopFrame) unmountHud();
  }

  // ------------------------------------------------------------------ 回放

  async function locate(step) {
    if (!step.target) return null;
    const found = await WAITER.waitFor(
      () => {
        const { element, via } = SELECTOR.resolve(step.target);
        if (!element) return null;
        if (!WAITER.isInteractable(element)) return null;
        return { element, via };
      },
      { timeout: step.timeoutMs || 10000, label: `${step.type} ${describeTarget(step.target)}` }
    );
    await WAITER.scrollIntoView(found.element);
    await WAITER.waitStable(found.element);
    return found;
  }

  function describeTarget(target) {
    if (!target) return '';
    const first = (target.candidates || [])[0];
    return first ? first.value : target.tag || '';
  }

  async function execute(step) {
    switch (step.type) {
      case 'scroll':
        await EXECUTOR.scroll(step);
        return { ok: true, via: null };
      default:
        break;
    }

    const found = await locate(step);
    if (!found) return { ok: false, error: '缺少定位信息' };
    const el = found.element;

    switch (step.type) {
      case 'click':
        await EXECUTOR.click(el);
        break;
      case 'input':
        if (step.masked) return { ok: false, error: '该步是敏感输入，值未被录制，需人工填写或配置变量' };
        await EXECUTOR.type(el, step.value ?? '');
        break;
      case 'select':
        await EXECUTOR.select(el, step.value);
        break;
      case 'check':
        await EXECUTOR.setChecked(el, !!step.checked);
        break;
      case 'focus':
        EXECUTOR.focus(el);
        break;
      case 'blur':
        EXECUTOR.blur(el);
        break;
      case 'key':
        EXECUTOR.key(el, step);
        break;
      case 'submit':
        if (typeof el.requestSubmit === 'function') el.requestSubmit();
        else el.submit();
        break;
      default:
        return { ok: false, error: `未知步骤类型：${step.type}` };
    }
    return { ok: true, via: found.via };
  }

  // ------------------------------------------------------------------ HUD

  let hudHost = null;

  function mountHud(mode, text) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => mountHud(mode, text), { once: true });
      return;
    }
    if (hudHost) {
      updateHud(mode, text);
      return;
    }
    hudHost = document.createElement('div');
    hudHost.id = HUD_ID;
    // Shadow DOM 隔离，避免页面样式串进来、也避免污染页面
    const shadow = hudHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          display: flex; align-items: center; gap: 8px;
          padding: 8px 14px; border-radius: 999px;
          font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #fff; background: rgba(20,20,22,.92);
          box-shadow: 0 6px 24px rgba(0,0,0,.28); pointer-events: none;
          backdrop-filter: blur(8px);
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff453a; }
        .dot.rec { animation: pulse 1.2s ease-in-out infinite; }
        .dot.play { background: #30d158; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
      </style>
      <div class="bar"><span class="dot"></span><span class="label"></span></div>
    `;
    document.body.appendChild(hudHost);
    updateHud(mode, text);
  }

  function updateHud(mode, text) {
    if (!hudHost || !hudHost.shadowRoot) return;
    const dot = hudHost.shadowRoot.querySelector('.dot');
    const label = hudHost.shadowRoot.querySelector('.label');
    dot.className = `dot ${mode === 'recording' ? 'rec' : 'play'}`;
    label.textContent = text || (mode === 'recording' ? '正在录制操作…' : '正在回放…');
  }

  function unmountHud() {
    if (hudHost && hudHost.parentNode) hudHost.parentNode.removeChild(hudHost);
    hudHost = null;
  }

  // ------------------------------------------------------------------ 消息

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'BR_START_RECORD':
        startRecording();
        sendResponse({ ok: true });
        return false;

      case 'BR_STOP_RECORD':
        stopRecording();
        sendResponse({ ok: true });
        return false;

      case 'BR_EXEC_STEP':
        if (isTopFrame) mountHud('replay', `回放第 ${message.index + 1} / ${message.total} 步：${message.step.type}`);
        execute(message.step)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
        return true; // 异步响应

      case 'BR_REPLAY_DONE':
        unmountHud();
        sendResponse({ ok: true });
        return false;

      case 'BR_PING':
        sendResponse({ ok: true, top: isTopFrame });
        return false;

      default:
        return false;
    }
  });

  // 页面（重）加载后主动握手：background 才知道该继续录制还是继续回放
  send({ type: 'BR_FRAME_READY', url: location.href, top: isTopFrame });
})();

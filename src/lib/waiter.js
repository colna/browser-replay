/**
 * 等待策略。
 *
 * 回放绝不复刻录制时的时间间隔 —— 录制时网络快慢、机器负载都不同，
 * sleep(录制间隔) 只会得到一个随机失败的脚本。一律等条件成立。
 */
(() => {
  if (window.__BR_WAITER__) return;

  const DEFAULT_TIMEOUT = 10000;
  const POLL_INTERVAL = 100;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * MutationObserver 负责「DOM 一变就立刻重试」，轮询兜住那些不改 DOM 的变化
   * （属性未变但元素从 display:none 变可见、canvas 内容更新等）。两者缺一都会偶发超时。
   */
  function waitFor(predicate, { timeout = DEFAULT_TIMEOUT, label = '' } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let observer = null;
      let timer = null;
      let deadline = null;

      const cleanup = () => {
        if (observer) observer.disconnect();
        if (timer) clearInterval(timer);
        if (deadline) clearTimeout(deadline);
      };

      const attempt = () => {
        if (settled) return;
        let value;
        try {
          value = predicate();
        } catch {
          return;
        }
        if (value) {
          settled = true;
          cleanup();
          resolve(value);
        }
      };

      attempt();
      if (settled) return;

      observer = new MutationObserver(attempt);
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      timer = setInterval(attempt, POLL_INTERVAL);

      deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`等待超时（${timeout}ms）${label ? '：' + label : ''}`));
      }, timeout);
    });
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function isInteractable(el) {
    if (!isVisible(el)) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  /**
   * 等元素静止：弹窗淡入 / 列表重排期间元素已存在但还在移动，
   * 此时点下去会点到蒙层或隔壁项。连续两帧包围盒不变才算稳定。
   */
  async function waitStable(el, { timeout = 2000 } = {}) {
    const start = Date.now();
    let last = null;
    let stableFrames = 0;

    while (Date.now() - start < timeout) {
      const rect = el.getBoundingClientRect();
      const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
      if (key === last) {
        stableFrames += 1;
        if (stableFrames >= 2) return true;
      } else {
        stableFrames = 0;
        last = key;
      }
      await nextFrame();
    }
    return false;
  }

  /** 元素被固定头 / 悬浮栏挡住时点击会落在遮挡物上，先滚到视口中央 */
  async function scrollIntoView(el) {
    const rect = el.getBoundingClientRect();
    const inView =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth;
    if (inView) return;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await nextFrame();
    await nextFrame();
  }

  window.__BR_WAITER__ = { waitFor, sleep, nextFrame, isVisible, isInteractable, waitStable, scrollIntoView };
})();

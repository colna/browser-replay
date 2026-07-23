/**
 * 动作执行层。
 *
 * 这里全部走 DOM 合成事件（`isTrusted === false`）。绝大多数站点不校验它，
 * 但触发下载、`window.open`、原生文件选择这类受用户手势保护的行为会被浏览器拒绝。
 * 接口按「一个动作一个方法」切开，就是为了后续可以整体换成 chrome.debugger 的
 * CDP 可信事件后端，而不用改上层回放逻辑。
 */
(() => {
  if (window.__BR_EXECUTOR__) return;

  const { sleep, nextFrame } = window.__BR_WAITER__;

  /**
   * React / Vue 会劫持 value 的 setter 来做受控绑定，
   * 直接 `el.value = x` 框架收不到通知，输入会在下一次渲染被打回去。
   * 必须拿到原型链上的原生 setter 调用，再手动派发 input。
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
  }

  function fireMouse(el, type, coords, extra = {}) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
        ...coords,
        ...extra
      })
    );
  }

  function firePointer(el, type, coords) {
    if (typeof PointerEvent !== 'function') return;
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        ...coords
      })
    );
  }

  /**
   * 完整还原一次真实点击的事件序列。只发 `click` 的话，
   * 依赖 mousedown 打开的下拉菜单、依赖 pointerdown 的拖拽组件都不会响应。
   */
  async function click(el) {
    const coords = centerOf(el);
    firePointer(el, 'pointerover', coords);
    fireMouse(el, 'mouseover', coords);
    firePointer(el, 'pointerdown', coords);
    fireMouse(el, 'mousedown', coords);

    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    await nextFrame();

    firePointer(el, 'pointerup', coords);
    fireMouse(el, 'mouseup', coords);
    fireMouse(el, 'click', coords, { detail: 1 });
  }

  /** 把选区铺满整个元素，让后续插入等价于「全选后覆盖」 */
  function selectAllWithin(el) {
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  /**
   * 自绘编辑器（Lexical / Draft.js / Snapchat 的输入框等）的内容真源是内部 model，
   * DOM 只是渲染结果 —— 直接写 `textContent` 它根本收不到，发送时读的还是空 model，
   * 于是「每一步都执行成功、消息却是空的」，比报错更难发现。
   *
   * 这类编辑器的输入通道是 `beforeinput`：它在那里 `preventDefault()` 并把内容写进
   * 自己的 model。所以合成一个 beforeinput 喂给它 —— 事件被吃掉（`dispatchEvent`
   * 返回 false）就说明编辑器接管了，此时**不能**再去碰 DOM，否则只会让两边状态打架。
   *
   * 注意 `execCommand('insertText')` 在这里没用：实测它直接改 DOM 而**不派发 beforeinput**，
   * 效果等同于直写 textContent。
   */
  async function typeIntoEditable(el, value) {
    selectAllWithin(el);

    if (value !== '') {
      const taken = !el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: value
        })
      );
      if (taken) {
        // 编辑器可能在下一帧才把 model 渲染出来
        await nextFrame();
        return;
      }
    }

    // 普通 contenteditable：没人接管，自己写。派发 input 让框架感知。
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }));
  }

  async function type(el, value) {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });

    if (el.isContentEditable) {
      await typeIntoEditable(el, value);
      return;
    }

    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  async function setChecked(el, checked) {
    if (el.checked === checked) return;
    await click(el);
    // 有些组件把 change 吃掉自己管状态，点完没变就直接置位补一发
    if (el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
  }

  async function select(el, value) {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function focus(el) {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  }

  function blur(el) {
    if (typeof el.blur === 'function') el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  function key(el, descriptor) {
    const target = el || document.activeElement || document.body;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: descriptor.key,
      code: descriptor.code || '',
      ctrlKey: !!descriptor.ctrlKey,
      shiftKey: !!descriptor.shiftKey,
      altKey: !!descriptor.altKey,
      metaKey: !!descriptor.metaKey
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));

    // Enter 在原生表单里默认会提交，合成事件不会 —— 显式补上
    if (descriptor.key === 'Enter' && target.form && typeof target.form.requestSubmit === 'function') {
      target.form.requestSubmit();
    }
  }

  async function scroll(step) {
    if (step.target) {
      const resolved = window.__BR_SELECTOR__.resolve(step.target);
      if (resolved.element) {
        resolved.element.scrollTop = step.scrollTop || 0;
        resolved.element.scrollLeft = step.scrollLeft || 0;
        return;
      }
    }
    window.scrollTo({ top: step.scrollY || 0, left: step.scrollX || 0, behavior: 'instant' });
    await sleep(50);
  }

  window.__BR_EXECUTOR__ = { click, type, setChecked, select, focus, blur, key, scroll, setNativeValue };
})();

/**
 * 纯文本编辑模型：把一个 keystroke 步骤作用在 `{value, start, end}` 上，算出下一状态。
 *
 * 录制端和回放端共用同一份推进逻辑，避免两边各写一套、悄悄跑偏：
 * - 录制端拿它维护「影子缓冲」——每记一个键就推进一次，blur 时和输入框真实值一比，
 *   就知道键盘之外还有没有别的改动（粘贴 / 表情面板 / 自动填充 / insertText），有则补一步值快照兜底。
 * - 回放端拿它算出该写回的 value 和光标位置，再走原生 setter + 合成事件打进去。
 *
 * 只建模「选区安全」的单行/多行文本输入（<input type=text/search/tel/url> 与 <textarea>）。
 * 组合键选区扩展（Shift+方向）不建模——它只影响中间光标，最终值由末尾的值快照兜底纠正。
 */
(() => {
  if (window.__BR_KEYBOARD__) return;

  const EDIT_KEYS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

  /** 这个键是否该被当作「逐键」记录（其余交给通用按键逻辑或忽略） */
  function isKeystrokeKey(key, multiline) {
    if (key === 'Enter') return !!multiline; // 单行 Enter 常触发提交，交给原有 key/submit 逻辑
    if (EDIT_KEYS.has(key)) return true;
    return key.length === 1; // 可打印字符（含空格）
  }

  /** 一步 keystroke 要插入的字符串；不插入内容则返回 null */
  function insertionOf(step) {
    if (step.text != null) return step.text; // IME 提交文本
    if (step.char != null) return step.char; // 单个可打印字符
    if (step.key === 'Enter' && step.multiline) return '\n';
    return null;
  }

  function applyKeystroke(state, step) {
    let { value, start, end } = state;
    const s = Math.min(start, end);
    const e = Math.max(start, end);

    const insert = insertionOf(step);
    if (insert != null) {
      value = value.slice(0, s) + insert + value.slice(e);
      const caret = s + insert.length;
      return { value, start: caret, end: caret };
    }

    switch (step.key) {
      case 'Backspace': {
        if (s !== e) return { value: value.slice(0, s) + value.slice(e), start: s, end: s };
        if (s > 0) return { value: value.slice(0, s - 1) + value.slice(s), start: s - 1, end: s - 1 };
        return { value, start: s, end: s };
      }
      case 'Delete': {
        if (s !== e) return { value: value.slice(0, s) + value.slice(e), start: s, end: s };
        return { value: value.slice(0, s) + value.slice(s + 1), start: s, end: s };
      }
      case 'ArrowLeft': {
        const caret = Math.max(0, (s === e ? s : s) - 1);
        return { value, start: caret, end: caret };
      }
      case 'ArrowRight': {
        const caret = Math.min(value.length, (s === e ? e : e) + 1);
        return { value, start: caret, end: caret };
      }
      case 'Home':
        return { value, start: 0, end: 0 };
      case 'End':
        return { value, start: value.length, end: value.length };
      default:
        return { value, start, end };
    }
  }

  /** 从元素读出当前 {value, start, end}；拿不到选区（部分类型不支持）就退到末尾 */
  function snapshot(el) {
    const value = el.value != null ? el.value : '';
    let start = el.selectionStart;
    let end = el.selectionEnd;
    if (start == null || end == null) {
      start = end = value.length;
    }
    return { value, start, end };
  }

  window.__BR_KEYBOARD__ = { applyKeystroke, isKeystrokeKey, insertionOf, snapshot, EDIT_KEYS };
})();

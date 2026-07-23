/**
 * 选择器生成 / 解析。
 *
 * 硬约束：**任何输出都不得包含 class 选择器**（`.foo` 或 `[class=...]`）。
 * 原因是 class 在 CSS-in-JS / 原子化 CSS / 构建 hash 下几乎必然漂移，
 * 录制当时唯一的 `.css-1x2y3z` 在下次构建后就是另一个名字。
 * 结构定位一律退到 `tag:nth-of-type(n)`。
 */
(() => {
  if (window.__BR_SELECTOR__) return;

  // 稳定性从高到低，score 用于导出 JSON 时让人一眼看出这条脚本有多脆
  const TEST_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
    'data-automation-id',
    'data-track-id'
  ];

  // 这些属性值本身就是内容语义，适合做定位
  const SEMANTIC_ATTRS = ['name', 'aria-label', 'placeholder', 'title', 'alt', 'href', 'type', 'role'];

  const MAX_TEXT_LEN = 60;

  function escapeAttrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function escapeIdent(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  /**
   * id 未必稳定：React `useId`、Radix/MUI/Ember 的自增 id、构建 hash 都会变。
   * 判不准时宁可当作不稳定 —— 它只是降级到下一个候选，不会丢失定位能力。
   */
  function isUnstableId(id) {
    if (!id || typeof id !== 'string') return true;
    if (id.length > 50) return true;
    if (/^:r[0-9a-z]+:$/i.test(id)) return true;              // React useId
    if (/^[0-9]/.test(id)) return true;                       // 数字开头
    if (/[0-9a-f]{8,}/i.test(id)) return true;                // 长 hex
    if (/\d{4,}/.test(id)) return true;                       // 长数字串，多为自增
    if (/^(ember|ext-gen|yui|radix-|mui-|headlessui-|downshift-|react-aria)/i.test(id)) return true;
    return false;
  }

  function normalizeText(node) {
    const raw = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return raw.length > MAX_TEXT_LEN ? '' : raw;
  }

  function tagOf(el) {
    return el.tagName.toLowerCase();
  }

  /** 元素所在的查询根：shadowRoot 或 document */
  function rootOf(el) {
    const root = el.getRootNode();
    return root instanceof ShadowRoot || root instanceof Document ? root : document;
  }

  function isUniqueIn(root, css, target) {
    let found;
    try {
      found = root.querySelectorAll(css);
    } catch {
      return false;
    }
    return found.length === 1 && found[0] === target;
  }

  /** 单层结构定位：tag + nth-of-type（同 tag 兄弟多于一个时才加序号） */
  function nthOfType(el) {
    const tag = tagOf(el);
    const parent = el.parentElement;
    if (!parent) return tag;
    const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
    if (sameTag.length <= 1) return tag;
    return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }

  // 地标标签在一个页面里通常只有一个，且极少因改版而挪位置，
  // 用它当结构路径的起点，能把 `html > body > div > div > nav > …` 砍成 `nav > …`。
  // 路径每短一层，扛住改版的概率就高一截。
  const LANDMARK_TAGS = ['nav', 'main', 'header', 'footer', 'aside', 'form', 'table'];

  /** 该元素自身有没有一个「不依赖祖先」就唯一的锚点选择器 */
  function selfAnchor(el, root) {
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) {
        const css = `[${attr}="${escapeAttrValue(v)}"]`;
        if (isUniqueIn(root, css, el)) return css;
      }
    }
    if (!isUnstableId(el.id)) {
      const css = `#${escapeIdent(el.id)}`;
      if (isUniqueIn(root, css, el)) return css;
    }
    const tag = tagOf(el);
    if (LANDMARK_TAGS.includes(tag) && isUniqueIn(root, tag, el)) return tag;
    return null;
  }

  /**
   * 结构路径。从目标往上走，遇到带锚点的祖先就停 —— 路径越短越抗改版。
   * 全程只用 tag:nth-of-type，绝不引入 class。
   */
  function structuralPath(el, root) {
    const parts = [];
    let node = el;
    let depth = 0;

    while (node && node.nodeType === Node.ELEMENT_NODE && depth < 12) {
      if (depth > 0) {
        const anchor = selfAnchor(node, root);
        if (anchor) {
          parts.unshift(anchor);
          return parts.join(' > ');
        }
      }
      parts.unshift(nthOfType(node));

      const parent = node.parentElement;
      if (!parent) break;
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  /** 与 <input> 关联的 label 文本（label[for] 或包裹式 label） */
  function labelTextOf(el) {
    if (el.id && !isUnstableId(el.id)) {
      const root = rootOf(el);
      const label = root.querySelector(`label[for="${escapeAttrValue(el.id)}"]`);
      if (label) return normalizeText(label);
    }
    const wrapper = el.closest && el.closest('label');
    if (wrapper) return normalizeText(wrapper);
    return '';
  }

  /**
   * 生成候选列表。每条都当场验证唯一性，不唯一的直接丢弃 ——
   * 留着一个「能匹配 3 个元素」的选择器，回放时点错的代价远高于少一个候选。
   */
  function buildCandidates(el) {
    const root = rootOf(el);
    const tag = tagOf(el);
    const out = [];
    const seen = new Set();

    const push = (kind, value, score, needUnique = true) => {
      if (!value || seen.has(value)) return;
      if (needUnique && !isUniqueIn(root, value, el)) return;
      seen.add(value);
      out.push({ kind, value, score });
    };

    // 1. 测试属性 —— 专为自动化而设，最稳
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) push('testAttr', `[${attr}="${escapeAttrValue(v)}"]`, 100);
    }

    // 2. id
    if (!isUnstableId(el.id)) push('id', `#${escapeIdent(el.id)}`, 92);

    // 3. name（表单元素的天然主键）
    const name = el.getAttribute('name');
    if (name) {
      push('name', `${tag}[name="${escapeAttrValue(name)}"]`, 88);
      push('name', `[name="${escapeAttrValue(name)}"]`, 84);
    }

    // 4. 无障碍语义
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) push('aria', `${tag}[aria-label="${escapeAttrValue(ariaLabel)}"]`, 80);

    const role = el.getAttribute('role');
    if (role && ariaLabel) {
      push('aria', `[role="${escapeAttrValue(role)}"][aria-label="${escapeAttrValue(ariaLabel)}"]`, 78);
    }

    // 5. 其余语义属性（含组合，单个不唯一时组合往往就唯一了）
    for (const attr of SEMANTIC_ATTRS) {
      if (attr === 'name' || attr === 'aria-label' || attr === 'role') continue;
      const v = el.getAttribute(attr);
      if (!v || v.length > 100) continue;
      push('attr', `${tag}[${attr}="${escapeAttrValue(v)}"]`, attr === 'placeholder' ? 74 : 66);
    }

    const typeAttr = el.getAttribute('type');
    if (typeAttr && name) {
      push('attr', `${tag}[type="${escapeAttrValue(typeAttr)}"][name="${escapeAttrValue(name)}"]`, 76);
    }

    // 6. 结构路径 —— 一定能生成，作为 CSS 类候选的保底
    push('structural', structuralPath(el, root), 40);

    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /**
   * 文本 / label 属于非 CSS 候选，单独放一格：
   * 页面结构大改时它常常是唯一还活着的线索，但它不能直接喂给 querySelector。
   */
  function buildTextHints(el) {
    const hints = {};
    const text = normalizeText(el);
    if (text) hints.text = text;

    const label = labelTextOf(el);
    if (label) hints.label = label;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) hints.ariaLabel = ariaLabel;

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) hints.placeholder = placeholder;

    return hints;
  }

  /** 元素在 shadow DOM 内时，记录一路的宿主选择器，回放时逐层穿透 */
  function shadowPath(el) {
    const path = [];
    let node = el;
    let guard = 0;
    while (guard < 10) {
      const root = node.getRootNode();
      if (!(root instanceof ShadowRoot)) break;
      const host = root.host;
      if (!host) break;
      path.unshift(describeHost(host));
      node = host;
      guard += 1;
    }
    return path;
  }

  function describeHost(host) {
    const root = rootOf(host);
    const anchor = selfAnchor(host, root);
    return anchor || structuralPath(host, root);
  }

  /** 祖先链最大层数。10 层在多数页面已经能走到 body 或某个地标容器。 */
  const MAX_ANCESTORS = 10;

  /** 祖先自身的直接文本（不含后代），用来认出「这是哪一行/哪个卡片」 */
  function directTextOf(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
    }
    out = out.replace(/\s+/g, ' ').trim();
    return out.length > MAX_TEXT_LEN ? out.slice(0, MAX_TEXT_LEN) + '…' : out;
  }

  // class 是项目硬约束（构建产物，改版即变）；style 是渲染结果，逐帧都可能不同
  const ANCESTOR_SKIP_ATTRS = ['class', 'style'];

  /**
   * 祖先的属性快照：**除 class / style 外全部取**。
   *
   * 早先这里走白名单（TEST_ATTRS + SEMANTIC_ATTRS），漏掉的恰恰是判断状态最需要的那些 ——
   * `aria-expanded` / `aria-selected` / `aria-checked` 说明当前是展开还是选中，
   * `tabindex` / `disabled` 说明能不能交互，站点自定义的 `data-*` 往往是唯一的语义标记。
   * 白名单永远追不上各家站点，所以反过来：默认全收，只排掉明确是噪声的。
   *
   * 空值属性照记（`disabled` / `hidden` 这类布尔属性，「存在」本身就是信息）。
   * id 例外，仍按 isUnstableId 判稳后才记 —— 否则每次录制都会多出一堆 `:r7:`，没法比对。
   */
  function ancestorAttrs(el) {
    const attrs = {};
    const list = el.attributes;
    for (let i = 0; i < list.length; i += 1) {
      const { name, value } = list[i];
      if (name === 'id' || ANCESTOR_SKIP_ATTRS.includes(name)) continue;
      attrs[name] = value.length > MAX_TEXT_LEN ? value.slice(0, MAX_TEXT_LEN) + '…' : value;
    }
    if (el.id && !isUnstableId(el.id)) attrs.id = el.id;
    return attrs;
  }

  /**
   * 往外 10 层祖先的结构快照。depth 从 1 起算（1 = 直接父元素）。
   *
   * 记的是每层祖先「自己」是什么，不是它的 outerHTML —— 第 10 层祖先的 outerHTML
   * 往往就是大半个页面，塞进导出 JSON 既没法读也没法比对。
   * 逐层带上 nth-of-type 与 childCount 后，「第几个列表项」这类上下文一样能还原。
   */
  function buildAncestors(el) {
    const chain = [];
    let node = el;
    let depth = 0;

    while (chain.length < MAX_ANCESTORS && depth < MAX_ANCESTORS * 2) {
      depth += 1;
      let parent = node.parentElement;
      let crossedShadow = false;

      // 到了 shadow root 的顶：继续往宿主元素上走，否则链会在组件边界断掉
      if (!parent) {
        const root = node.getRootNode();
        if (root instanceof ShadowRoot && root.host) {
          parent = root.host;
          crossedShadow = true;
        }
      }
      if (!parent) break;

      const entry = {
        depth: chain.length + 1,
        tag: tagOf(parent),
        nth: nthOfType(parent),
        childCount: parent.children.length
      };
      const attrs = ancestorAttrs(parent);
      if (Object.keys(attrs).length) entry.attrs = attrs;
      const text = directTextOf(parent);
      if (text) entry.text = text;
      if (crossedShadow) entry.shadowHost = true;

      chain.push(entry);
      node = parent;
      if (entry.tag === 'body' || entry.tag === 'html') break;
    }

    return chain;
  }

  function describe(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = el.getBoundingClientRect();
    return {
      candidates: buildCandidates(el),
      hints: buildTextHints(el),
      shadowPath: shadowPath(el),
      ancestors: buildAncestors(el),
      tag: tagOf(el),
      // 视口相对比例：所有选择器都失效时的最后手段，换分辨率仍可近似还原
      viewportRatio: {
        x: Number(((rect.left + rect.width / 2) / Math.max(window.innerWidth, 1)).toFixed(4)),
        y: Number(((rect.top + rect.height / 2) / Math.max(window.innerHeight, 1)).toFixed(4))
      }
    };
  }

  // ---------------------------------------------------------------- resolve

  function resolveRoot(shadowPathList) {
    let root = document;
    for (const hostSelector of shadowPathList || []) {
      let host;
      try {
        host = root.querySelector(hostSelector);
      } catch {
        return null;
      }
      if (!host || !host.shadowRoot) return null;
      root = host.shadowRoot;
    }
    return root;
  }

  function matchByHints(root, target) {
    const hints = target.hints || {};
    const tag = target.tag;
    const scope = root.querySelectorAll(tag || '*');
    const wanted = hints.text || hints.ariaLabel || hints.label || hints.placeholder;
    if (!wanted) return null;

    const exact = [];
    const loose = [];
    for (const el of scope) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = el.getAttribute('aria-label') || '';
      const ph = el.getAttribute('placeholder') || '';
      if (text === wanted || aria === wanted || ph === wanted) exact.push(el);
      else if (text.includes(wanted) && text.length < wanted.length * 3) loose.push(el);
    }
    if (exact.length === 1) return exact[0];
    if (exact.length === 0 && loose.length === 1) return loose[0];
    return null;
  }

  /**
   * 按候选顺序解析。返回命中的元素与命中方式，供调用方记录「这一步靠什么定位成功」——
   * 回放报告里能直接看出哪些步骤已经在靠兜底策略苟着，是脚本该维护的信号。
   */
  const HINT_SCORE = 55;

  function tryCandidates(root, candidates) {
    for (const candidate of candidates) {
      let el;
      try {
        el = root.querySelector(candidate.value);
      } catch {
        continue;
      }
      if (el) return { element: el, via: candidate };
    }
    return null;
  }

  function resolve(target) {
    if (!target) return { element: null, via: null };
    const root = resolveRoot(target.shadowPath);
    if (!root) return { element: null, via: null };

    const candidates = target.candidates || [];

    // 语义类候选（测试属性 / id / name / aria）优先
    const strong = tryCandidates(root, candidates.filter((c) => c.score >= HINT_SCORE));
    if (strong) return strong;

    // 文本线索排在结构路径之前：一个 6 层的 `nav > div > div > div` 只要中间插进一个
    // 包装层就全废，而按钮上的文字通常改版也还在。深层结构路径是所有候选里最不可信的一个。
    const byHint = matchByHints(root, target);
    if (byHint) {
      return { element: byHint, via: { kind: 'hint', value: JSON.stringify(target.hints), score: HINT_SCORE } };
    }

    return tryCandidates(root, candidates.filter((c) => c.score < HINT_SCORE)) || { element: null, via: null };
  }

  window.__BR_SELECTOR__ = { describe, resolve, buildCandidates, isUnstableId, buildAncestors };
})();

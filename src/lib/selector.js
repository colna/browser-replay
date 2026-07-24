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

  // 这些属性值本身就是内容语义，适合做定位。
  // 判据是「它描述这个元素**是什么**」——`aria-placeholder` / `contenteditable` 同样满足，
  // 而 Instagram DM 的编辑区身上恰好只有这类属性，漏掉它们就只能退到结构路径。
  const SEMANTIC_ATTRS = [
    'name',
    'aria-label',
    'aria-placeholder',
    'placeholder',
    'title',
    'alt',
    'href',
    'type',
    'role',
    'contenteditable'
  ];

  /**
   * 描述「现在处于什么状态」的属性，绝不能进选择器 —— 它们随交互变化，
   * 录制时 `aria-expanded="true"`，回放时菜单还没展开就永远匹配不上。
   * （祖先快照里仍然记录它们：那是给人看状态用的，和定位是两回事。）
   */
  const STATE_ATTRS = new Set([
    'aria-expanded',
    'aria-selected',
    'aria-checked',
    'aria-pressed',
    'aria-current',
    'aria-hidden',
    'aria-busy',
    'aria-disabled',
    'aria-describedby',
    'aria-labelledby',
    'disabled',
    'checked',
    'open',
    'hidden',
    'data-state',
    'data-focus-visible-added'
  ]);

  const MAX_TEXT_LEN = 60;

  /**
   * 站点自定义的 `data-*` 标记（Instagram 的 `data-pagelet`、各家的 `data-module` 等）
   * 常常是页面里最稳的东西 —— 它是给自家代码用的，不随视觉改版而变。
   * 但值必须稳定：`data-auto-logging-id="fb1157e97"` 这种一次一变的要排除。
   */
  function identityDataAttrs(el) {
    const out = [];
    for (const attr of el.attributes || []) {
      const name = attr.name;
      if (!name.startsWith('data-') || STATE_ATTRS.has(name)) continue;
      if (TEST_ATTRS.includes(name)) continue; // 已按更高优先级单独处理
      const value = attr.value;
      if (!value || value.length > 100 || isUnstableId(value)) continue;
      out.push([name, value]);
    }
    return out;
  }

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
  /**
   * 逐层强制标号。`nthOfType` 在「同标签兄弟只有一个」时退化成裸 tag，
   * 碰上 Instagram 这种每层单个 div 的深嵌套，整条路径会变成 `div > div > … > div`，
   * 匹配上千个元素而被当作不唯一丢弃。加上 nth-child 才能把它们区分开。
   */
  function nthChild(el) {
    const parent = el.parentElement;
    if (!parent) return tagOf(el);
    return `${tagOf(el)}:nth-child(${Array.prototype.indexOf.call(parent.children, el) + 1})`;
  }

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

  /**
   * 该元素自身有没有一个「不依赖祖先」就唯一的锚点选择器。
   *
   * 锚点决定结构路径从哪起算，是路径长度的唯一杠杆 —— 只认测试属性 / id / 地标标签
   * 会白白错过站点自己的稳定标记：Instagram 的 `[data-pagelet="IGDComposerForCannes"]`
   * 就在录到的祖先链里，用上它能把 12 层裸 div 砍成 3 层。
   * 判据统一是「值稳定 + 在文档里唯一」，不是属性名在不在某张小名单上。
   */
  function selfAnchor(el, root) {
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) {
        const css = `[${attr}="${escapeAttrValue(v)}"]`;
        if (isUniqueIn(root, css, el)) return css;
      }
    }
    for (const [attr, v] of identityDataAttrs(el)) {
      const css = `[${attr}="${escapeAttrValue(v)}"]`;
      if (isUniqueIn(root, css, el)) return css;
    }
    for (const attr of SEMANTIC_ATTRS) {
      if (attr === 'role' || attr === 'type' || attr === 'contenteditable') continue; // 太泛，单独用不足以当锚
      const v = el.getAttribute(attr);
      if (!v || v.length > 100) continue;
      const css = `[${attr}="${escapeAttrValue(v)}"]`;
      if (isUniqueIn(root, css, el)) return css;
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
  function structuralPath(el, root, useNthChild = false) {
    const parts = [];
    let node = el;
    let depth = 0;
    // 常规路径封顶 12 层 —— 越长越脆，宁可短一点。但加强版是「短路径已经不唯一」时的最后手段，
    // 半截相对路径（`div > div > … > div`）会匹配到成百上千个元素，还不如一路走到锚点/根。
    const maxDepth = useNthChild ? 30 : 12;

    while (node && node.nodeType === Node.ELEMENT_NODE && depth < maxDepth) {
      if (depth > 0) {
        const anchor = selfAnchor(node, root);
        if (anchor) {
          parts.unshift(anchor);
          return parts.join(' > ');
        }
      }
      parts.unshift(useNthChild ? nthChild(node) : nthOfType(node));

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
      if (!value || seen.has(value)) return false;
      if (needUnique && !isUniqueIn(root, value, el)) return false;
      seen.add(value);
      out.push({ kind, value, score });
      return true;
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

    // 5. 站点自定义标记 —— `data-pagelet` 这类是给自家代码用的，不随视觉改版而变
    for (const [attr, v] of identityDataAttrs(el)) {
      push('dataAttr', `[${attr}="${escapeAttrValue(v)}"]`, 70);
    }

    // 6. 其余语义属性。`role` 单独用太泛（一个页面几十个 role="button"），只参与组合
    const singles = [];
    for (const attr of SEMANTIC_ATTRS) {
      if (attr === 'name' || attr === 'aria-label') continue;
      const v = el.getAttribute(attr);
      if (!v || v.length > 100) continue;
      const clause = `[${attr}="${escapeAttrValue(v)}"]`;
      singles.push(clause);
      if (attr === 'role') continue;
      push('attr', `${tag}${clause}`, attr === 'placeholder' || attr === 'aria-placeholder' ? 74 : 66);
    }

    const typeAttr = el.getAttribute('type');
    if (typeAttr && name) {
      push('attr', `${tag}[type="${escapeAttrValue(typeAttr)}"][name="${escapeAttrValue(name)}"]`, 76);
    }

    // 7. 属性两两组合 —— 单个都不唯一时，组合往往就唯一了。
    // 自绘编辑器正是这种形态：`[role="textbox"]` 和 `[contenteditable="true"]` 各自满页都是，
    // 合起来就只剩它一个。
    for (let i = 0; i < singles.length; i += 1) {
      for (let j = i + 1; j < singles.length; j += 1) {
        push('attrPair', `${tag}${singles[i]}${singles[j]}`, 62);
      }
    }

    // 6. 结构路径 —— 保底候选。nth-of-type 更抗兄弟增删，优先；它不唯一时才退到 nth-child。
    const looseePath = structuralPath(el, root);
    const strictPath = structuralPath(el, root, true);
    const gotStructural = push('structural', looseePath, 40) || push('structural', strictPath, 36);

    // 两条都不唯一、且此前一个候选都没攒到：宁可留一条可能选错的，也好过零候选。
    // 候选为空时回放不但必然失败，连「已尝试了哪些选择器」都打印不出来，用户根本无从判断。
    if (!gotStructural && out.length === 0 && (strictPath || looseePath)) {
      out.push({ kind: 'structural', value: strictPath || looseePath, score: 20 });
    }

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

  /**
   * 这个元素像不像录制时那一个。
   *
   * 只对弱候选（结构路径）启用：深层路径很容易命中**同构的另一条链**，
   * 而「找到了但找错了」比「没找到」更糟 —— 它不会报错，只会静默地点错地方。
   * 判据取录制时就固定下来的身份特征（标签、aria-label），不取会变的内容文本。
   */
  function looksLikeTarget(el, target) {
    if (target.tag && tagOf(el) !== target.tag) return false;
    const hints = target.hints || {};
    if (hints.ariaLabel && (el.getAttribute('aria-label') || '') !== hints.ariaLabel) return false;
    if (hints.placeholder && (el.getAttribute('placeholder') || '') !== hints.placeholder) return false;
    return true;
  }

  function tryCandidates(root, candidates, target, verify = false) {
    for (const candidate of candidates) {
      let matches;
      try {
        matches = root.querySelectorAll(candidate.value);
      } catch {
        continue;
      }
      if (!matches.length) continue;
      if (!verify) return { element: matches[0], via: candidate };
      // 逐个看，第一个不像不代表都不像：非唯一路径命中多个时，对的那个可能排在后面
      for (const el of matches) {
        if (looksLikeTarget(el, target)) return { element: el, via: candidate };
      }
    }
    return null;
  }

  function resolve(target) {
    if (!target) return { element: null, via: null };
    const root = resolveRoot(target.shadowPath);
    if (!root) return { element: null, via: null };

    const candidates = target.candidates || [];

    // 语义类候选（测试属性 / id / name / aria）优先：选择器本身已经编码了身份，不必再校验
    const strong = tryCandidates(root, candidates.filter((c) => c.score >= HINT_SCORE));
    if (strong) return strong;

    // 文本线索排在结构路径之前：一个 6 层的 `nav > div > div > div` 只要中间插进一个
    // 包装层就全废，而按钮上的文字通常改版也还在。深层结构路径是所有候选里最不可信的一个。
    const byHint = matchByHints(root, target);
    if (byHint) {
      return { element: byHint, via: { kind: 'hint', value: JSON.stringify(target.hints), score: HINT_SCORE } };
    }

    // 结构路径必须过「像不像」这一关，不像就当作没找到 —— 没有「都不像就退回第一个」这条后路。
    //
    // 实测代价：Instagram 的发送按钮在输入框为空时会变成麦克风，位置一模一样。
    // 语义候选（aria-label="发送"）匹配不上后退到结构路径，按位置命中麦克风，
    // 于是「回放」变成了「开始录音」。找不到只是这一步失败，点错却是执行了另一个动作 ——
    // 后者的代价高得多，宁可停下来报错。
    const weak = candidates.filter((c) => c.score < HINT_SCORE);
    return tryCandidates(root, weak, target, true) || { element: null, via: null };
  }

  window.__BR_SELECTOR__ = { describe, resolve, buildCandidates, isUnstableId, buildAncestors };
})();

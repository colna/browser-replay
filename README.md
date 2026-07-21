# Browser Replay

录制浏览器操作（点击 / 输入 / 聚焦 / 选择 / 勾选 / 按键 / 滚动 / 导航），回放时自动重做一遍，并可导出成 JSON。

**选择器不使用 class** —— class 在 CSS-in-JS、原子化 CSS、构建 hash 下几乎必然漂移，录制当时唯一的 `.css-1x2y3z` 下次构建就是另一个名字。

定位优先级（每条候选生成时当场验证唯一性，不唯一即丢弃）：

| 优先级 | 方式 | 分值 |
|---|---|---|
| 1 | `[data-testid="…"]` 等测试属性 | 100 |
| 2 | `#id`（**排除**动态 id：React `useId` 的 `:r7:`、长 hex、纯数字开头、Radix/MUI 前缀） | 92 |
| 3 | `input[name="…"]` | 88 |
| 4 | `[aria-label]` / `[placeholder]` / `[type]` 组合 | 66–80 |
| 5 | 元素文本 / label / `aria-label`（非 CSS，回放时遍历匹配） | 55 |
| 6 | `tag:nth-of-type(n)` 结构路径 | 40 |

两个刻意的取舍：

- **文本排在结构路径之前。** 6 层的 `nav > div > div > div` 只要中间插进一个包装层就全废，而按钮上的文字改版后通常还在。深层结构路径是所有候选里最不可信的一个。
- **结构路径从最近的锚点或 `nav` / `main` / `form` 等地标标签起算**，不从 `html > body` 一路铺下来。路径每短一层，扛住改版的概率就高一截。

## 安装

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录

## 使用

| 操作 | 说明 |
|---|---|
| 开始录制 | 点插件图标 → 「开始录制」，然后正常操作页面。右下角有录制浮标，地址栏图标显示 `REC` |
| 停止录制 | 再点插件图标 → 「停止录制」 |
| 回放 | 在脚本列表点「回放」。回放会在**当前标签页**执行 |
| 查看 / 编辑 | 点「步骤」，可逐步查看定位方式与取值，删掉不需要的步骤 |
| 导出 | 步骤页 → 「复制 JSON」/「下载 JSON」 |
| 导入 | 顶部「导入」，选之前导出的 JSON |

密码框与含 `password` / `otp` / `cvv` 等字样的输入**只记录位置、不记录值**，回放到该步会停下来提示。

## 导出的 JSON

```jsonc
{
  "format": "browser-replay@1",
  "name": "录制 2026/7/21 01:30:00",
  "startUrl": "https://example.com/login",
  "stepCount": 16,
  "steps": [
    {
      "index": 1,
      "type": "click",
      "selector": "[data-testid=\"submit-btn\"]",   // 最优候选，可直接喂 querySelector
      "selectorKind": "testAttr",                   // 定位方式
      "selectorScore": 100,                         // 越低说明这步越脆
      "selectorFallbacks": [                        // 主选择器失效时依次尝试
        "button[type=\"submit\"]",
        "#demo-form > button"
      ],
      "tag": "button",
      "text": "提交",
      "sinceLastMs": 420
    }
  ]
}
```

`selectorScore` 是判断脚本健康度的直接信号：一片 100/92 说明页面有良好的测试属性；大量 40（`structural`）说明这份脚本挨不住几次改版。

## 回放策略

不复刻录制时的时间间隔（录制时的网络快慢跟回放时无关），每步执行前依次等待：

1. 元素出现（`MutationObserver` + 100ms 轮询兜底，超时 10s）
2. 可交互（可见、非 `disabled`、尺寸非零）
3. 滚动到视口中央
4. 连续两帧包围盒不变（躲开动画中的元素，否则会点到蒙层）

跨页面跳转由 background 持有游标续跑；某步触发导航导致消息通道断开时，视为该步已生效，等新页面加载完继续。

**步骤分级**：`focus` / `blur` / `scroll` 不改变页面数据状态，失败时跳过继续（等待上限 2s），回放完成后在进度条上显示跳过了几步；`click` / `input` / `select` / `check` / `submit` / `navigate` 失败则立即停下，因为在错误的页面状态上继续只会制造更多噪声。

**只录有意义的聚焦**：页面上大量元素会顺带拿到焦点（点按钮时按钮被聚焦、SPA 给布局容器挂 `tabindex`）。这些 focus 对回放毫无价值 —— 按钮的焦点由 click 自带，布局容器的焦点不影响任何状态 —— 却各占一个步骤，且这类元素往往只能退到长结构路径，是整条脚本里最先失效的部分。所以只录输入类元素（`input` / `textarea` / `select` / `contenteditable`）的聚焦。

**定位失败时的报错**会区分「页面上找不到该元素」和「找到了但一直不可交互（不可见 / 被禁用 / 尺寸为 0）」，并列出尝试过的每个选择器各匹配到几个元素 —— 直接回答「页面上到底还有没有这个东西」。

## 测试

需要本机装有 Chrome，无 npm 依赖。

```bash
npm test              # 选择器单测 + 录制回放端到端
npm run test:selector # 只跑选择器单测
```

- `test/selector-test.html` —— 在真实 DOM 上验证选择器生成：全库无 class、动态 id（React `useId`、hash id）不被采用、无标识节点退到 `nth-of-type`、候选唯一命中、shadow DOM 穿透
- `test/e2e.mjs` —— 起 headless Chrome，用 CDP Input domain 发**真实**（`isTrusted`）鼠标键盘事件录制一遍表单，再回放，断言表单数据完全一致

> E2E 没有加载扩展本体：Chrome 136+ 已禁用命令行 `--load-extension`（最小 MV3 扩展同样加载不了）。测试改用 chrome API 桩把**未经改动的** `content.js` 装进普通页面跑，覆盖录制器 / 选择器 / 执行器 / 等待策略。`background.js` 的存储与跨页调度需人工验证。

## 已知限制

- 事件是 DOM 合成的（`isTrusted === false`）。绝大多数站点无感，但触发下载、`window.open`、原生文件选择这类受用户手势保护的行为会被浏览器拒绝。需要时可把 `src/lib/executor.js` 换成 `chrome.debugger` 的 CDP 后端（代价是顶部常驻调试横幅）。
- 拖拽、原生 `<select>` 下拉层内的点击未覆盖。
- 回放只在单个标签页内进行，不跟随新开的标签页。

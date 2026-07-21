# Browser Replay

录制浏览器操作（点击 / 输入 / 聚焦 / 选择 / 勾选 / 按键 / 滚动 / 导航），回放时自动重做一遍，并可导出成 JSON。

**选择器不使用 class** —— class 在 CSS-in-JS、原子化 CSS、构建 hash 下几乎必然漂移，录制当时唯一的 `.css-1x2y3z` 下次构建就是另一个名字。定位一律走 `data-testid` → `id` → `name` → `aria-label` → 语义属性 → `tag:nth-of-type()` 结构路径。

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

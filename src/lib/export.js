/**
 * 导出格式。独立成模块有两个原因：
 * 一是它是对外契约（别的工具会消费这份 JSON），跟内部存储结构解耦；
 * 二是 service worker 里的代码没法直接跑测试，抽出来才能在 node 里断言。
 */
export function toExport(script) {
  return {
    format: 'browser-replay@1',
    id: script.id,
    name: script.name,
    startUrl: script.startUrl,
    createdAt: new Date(script.createdAt).toISOString(),
    stepCount: script.steps.length,
    note: '所有选择器均不含 class；structural 类型使用 tag:nth-of-type() 结构路径。',
    steps: script.steps.map((step, index) => {
      const target = step.target;
      const best = target && target.candidates && target.candidates[0];
      const out = {
        index,
        type: step.type,
        selector: best ? best.value : null,
        selectorKind: best ? best.kind : null,
        selectorScore: best ? best.score : null,
        selectorFallbacks: target ? (target.candidates || []).slice(1).map((c) => c.value) : [],
        tag: target ? target.tag : undefined,
        text: target && target.hints ? target.hints.text || undefined : undefined,
        sinceLastMs: step.sinceLastMs
      };
      if (step.url) out.url = step.url;
      if (step.value !== undefined) out.value = step.masked ? null : step.value;
      if (step.masked) out.masked = true;
      if (step.checked !== undefined) out.checked = step.checked;
      if (step.key) out.key = step.key;
      if (step.type === 'scroll') {
        out.scrollX = step.scrollX;
        out.scrollY = step.scrollY;
      }
      if (target && target.shadowPath && target.shadowPath.length) out.shadowPath = target.shadowPath;
      Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
      return out;
    })
  };
}

// Node 单测：DigitalHuman（REQ-MM-01/02/03/04） // NOSONAR
// 运行：node assets/js/_digitalhuman.test.mjs
import assert from 'node:assert';
import {
  DEFAULT_PROVIDERS, API_TIMEOUT, withTimeout, classifyError, isValidProvider, computeLipPulse, DigitalHuman
} from './digitalhuman.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

console.log('== withTimeout 超时包裹（REQ-MM-02 硬限） ==');
{
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 2000));
  await withTimeout(slow, 50).then(
    () => ok('不应在超时前resolve', false),
    (e) => ok('超时抛 timeout', e.message === 'timeout')
  );
  const fast = withTimeout(Promise.resolve('ok'), 1000);
  const r = await fast;
  ok('快速 Promise 正常透传', r === 'ok');
}

console.log('== classifyError 错误分类 ==');
{
  ok('timeout', classifyError(new Error('timeout')) === 'timeout');
  ok('abort 归一为 timeout 类', classifyError(new Error('aborted')) === 'timeout');
  ok('rate_limit(429)', classifyError(new Error('429 too many')) === 'rate_limit');
  ok('rate_limit(rate)', classifyError(new Error('rate limit')) === 'rate_limit');
  ok('network', classifyError(new Error('network unreachable')) === 'network');
  ok('network(fetch)', classifyError(new Error('fetch failed')) === 'network');
  ok('unknown', classifyError(new Error('boom')) === 'unknown');
  ok('null → unknown', classifyError(null) === 'unknown');
}

console.log('== isValidProvider 白名单（REQ-MM-03 防注入） ==');
{
  ok('白名单内合法', isValidProvider('heygen', DEFAULT_PROVIDERS) === true);
  ok('白名单外拒绝', isValidProvider('evil-host', DEFAULT_PROVIDERS) === false);
  ok('非字符串拒绝', isValidProvider('', DEFAULT_PROVIDERS) === false);
}

console.log('== computeLipPulse 口型脉冲近似（非真实唇形同步） ==');
{
  const p = computeLipPulse('今天天气真好呀我们一起出去玩吧');
  ok('返回时长与周期', p.durationMs > 0 && p.periodMs > 0);
  ok('如实标注非真实同步', p.label.includes('非真实唇形同步'));
  ok('空文本有最小下限', computeLipPulse('').durationMs === 400);
  ok('超长文本有上限封顶', computeLipPulse('x'.repeat(200)).durationMs === 8000);
}

console.log('== DigitalHuman.speak 走供应商成功（REQ-MM-01） ==');
{
  const played = [];
  const dh = new DigitalHuman({
    current: 'heygen',
    dhTransport: async (provider, text) => { return 'https://dh/' + provider + '?t=' + encodeURIComponent(text); },
    hooks: { onPlayVideo: (v) => played.push(v) }
  });
  const res = await dh.speak('你好呀');
  ok('成功标记 provider 模式', res.mode === 'provider' && res.provider === 'heygen');
  const url = played[0];
  ok('仅文本出境（不含上下文）', url.includes('heygen') && decodeURIComponent(url).includes('你好呀')
      && !url.toLowerCase().includes('memory') && !url.toLowerCase().includes('emotion'));
  ok('onPlayVideo hook 触发', played.length === 1);
}

console.log('== DigitalHuman.speak 超时降级 fallback（REQ-MM-02） ==');
{
  const falls = [];
  const dh = new DigitalHuman({
    current: 'zhiying',
    dhTransport: async () => new Promise((r) => setTimeout(() => r('slow'), 5000)),
    uiToastHook: () => {},
    hooks: { onFallback: (t, pulse) => falls.push({ t, pulse }) }
  });
  const res = await dh.speak('说点什么');
  ok('降级标记 fallback', res.mode === 'fallback');
  ok('降级 reason=timeout', res.reason === 'timeout');
  ok('fallbackCSS hook 触发', falls.length === 1 && falls[0].t === '说点什么');
  ok('降级带口型脉冲参数', falls[0].pulse && falls[0].pulse.periodMs > 0);
}

console.log('== DigitalHuman.speak 限流降级（REQ-MM-02） ==');
{
  const dh = new DigitalHuman({
    current: 'guiji',
    dhTransport: async () => { throw new Error('429 rate limit'); },
    uiToastHook: (m) => { dh._toast = m; },
    hooks: { onFallback: () => {} }
  });
  const res = await dh.speak('hi');
  ok('限流降级 reason=rate_limit', res.mode === 'fallback' && res.reason === 'rate_limit');
}

console.log('== DigitalHuman.speak 无传输 → 全程本地降级 ==');
{
  const dh = new DigitalHuman({ current: 'heygen', dhTransport: null, uiToastHook: () => {}, hooks: { onFallback: () => {} } });
  const res = await dh.speak('离线');
  ok('offline 降级', res.mode === 'fallback' && res.reason === 'offline');
}

console.log('== DigitalHuman.switch 多供应商切换（REQ-MM-03） ==');
{
  const saved = [];
  const dh = new DigitalHuman({
    providers: DEFAULT_PROVIDERS, current: 'heygen',
    config: { save: async (patch) => { saved.push(patch); return true; } }, dhTransport: null
  });
  await dh.switch('zhiying');
  ok('current 已切换', dh.provider() === 'zhiying');
  ok('配置已持久化', saved.length === 1 && saved[0].digitalHuman.provider === 'zhiying');
  let threw = false;
  try { dh.switch('evil'); } catch (e) { threw = true; }
  ok('非法供应商抛错', threw === true);
  ok('非法切换不改变 current', dh.provider() === 'zhiying');
}

console.log('== AI 水印挂接（REQ-COMP-01） ==');
{
  const badges = [];
  const dh = new DigitalHuman({
    current: 'heygen',
    dhTransport: async () => 'v',
    aiBadgeHook: (where) => badges.push(where),
    hooks: { onPlayVideo: () => {} }
  });
  await dh.speak('hi');
  ok('speak 入口挂 AI 水印', badges.length === 1 && badges[0] === 'digitalhuman');
}

await new Promise((r) => setTimeout(r, 50));
console.log('\n==== DigitalHuman 单测汇总 ====');
console.log('PASS=' + pass + '  FAIL=' + fail);
assert.strictEqual(fail, 0, '存在失败时断言终止');
process.exit(fail === 0 ? 0 : 1);
// Node 单测：Recorder（REQ-CT-02 纯逻辑部分） // NOSONAR
// 运行：node assets/js/_recorder.test.mjs
import assert from 'node:assert';
import { pickMimeType, computeBitrate, Recorder } from './recorder.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

console.log('== pickMimeType 编码选型（优先级交集） ==');
{
  ok('优先 vp9', pickMimeType(['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']) === 'video/webm;codecs=vp9');
  ok('无 vp9 退 vp8', pickMimeType(['video/webm;codecs=vp8', 'video/webm']) === 'video/webm;codecs=vp8');
  ok('仅 mp4', pickMimeType(['video/mp4']) === 'video/mp4');
  ok('空支持列表兜底 webm', pickMimeType([]) === 'video/webm');
}

console.log('== computeBitrate 码率（配置优先/默认 8M） ==');
{
  ok('默认 8Mbps', computeBitrate({}) === 8e6);
  ok('配置覆盖', computeBitrate({ studio: { recorderBitrate: 12e6 } }) === 12e6);
  ok('非法配置回退默认', computeBitrate({ studio: { recorderBitrate: -1 } }) === 8e6);
}

console.log('== Recorder.supportedMimeTypes（Node 环境返回空） ==');
{
  // Node 无 MediaRecorder → 返回空数组；供 pickMimeType 兜底
  ok('Node 下为空数组', Array.isArray(Recorder.supportedMimeTypes()) && Recorder.supportedMimeTypes().length === 0);
}

console.log('== Recorder.start 浏览器缺失时安全报错（不崩） ==');
{
  const r = new Recorder({});
  ok('start 是函数', typeof r.start === 'function');
  const p = r.start();
  ok('start 返回 Promise', typeof p.then === 'function');
  let rejected = false;
  try { await p; } catch (e) { rejected = true; ok('缺 getDisplayMedia 优雅拒绝', /getDisplayMedia/.test(e.message)); }
  ok('start 最终 rejected', rejected === true);
}

await new Promise((r) => setTimeout(r, 30));
console.log('\n==== Recorder 单测汇总 ====');
console.log('PASS=' + pass + '  FAIL=' + fail);
assert.strictEqual(fail, 0, '存在失败时断言终止');
process.exit(fail === 0 ? 0 : 1);

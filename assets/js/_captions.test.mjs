// Node 单测：SubtitleTrack（REQ-CT-01） // NOSONAR
// 运行：node assets/js/_captions.test.mjs
import assert from 'node:assert';
import { fmtTime, renderVTT, renderSRT, renderTXT, screenCue, SubtitleTrack } from './captions.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

console.log('== fmtTime 时间戳格式 ==');
{
  ok('vtt 用点分隔', fmtTime(1200, '.') === '00:00:01.200');
  ok('srt 用逗号分隔', fmtTime(4800, ',') === '00:00:04,800');
  ok('跨分钟进位', fmtTime(61000, '.') === '00:01:01.000');
  ok('负数归零', fmtTime(-5, '.') === '00:00:00.000');
}

console.log('== render 多模板导出 ==');
{
  const cues = [
    { startMs: 1200, endMs: 4800, speaker: 'xiaoya', text: '小雅今天也想你了哦' },
    { startMs: 5000, endMs: 8000, speaker: 'user', text: '我也是' }
  ];
  const vtt = renderVTT(cues);
  ok('VTT 头部', vtt.startsWith('WEBVTT'));
  ok('VTT 含时间轴(.).', vtt.includes('00:00:01.200 --> 00:00:04.800'));
  ok('VTT 含说话人+文本', vtt.includes('小雅：小雅今天也想你了哦'));
  const srt = renderSRT(cues);
  ok('SRT 时间轴用逗号', srt.includes('00:00:01,200 --> 00:00:04,800'));
  ok('SRT 序号', srt.trim().startsWith('1'));
  const txt = renderTXT(cues);
  ok('TXT 无时间轴', !txt.includes('-->') && txt.includes('你：我也是'));
}

console.log('== screenCue 入库安检（D5） ==');
{
  const blocked = { screen: () => ({ pass: false, text: '█' }) };
  ok('底线词拦截', screenCue('违规', blocked).pass === false);
  const pass1 = { screen: (t) => ({ pass: true, text: t }) };
  ok('正常透传', screenCue('你好', pass1).pass === true);
}

console.log('== SubtitleTrack.push 入库即滤 + 内存累积 ==');
{
  let stored = [];
  const adapter = { put: (r) => { stored.push(r); return Promise.resolve(); }, getAll: () => Promise.resolve(stored) };
  const st = new SubtitleTrack({ safety: { screen: (t) => (t === '违规' ? { pass: false, text: '█' } : { pass: true, text: t }) }, adapter, now: () => 100000 });
  const a = st.push({ speaker: 'xiaoya', text: '今天开心吗' });
  ok('正常 cue 入库', a && a.text === '今天开心吗' && a.speaker === 'xiaoya');
  ok('screened 标记', a.screened === true);
  const b = st.push({ speaker: 'user', text: '违规' });
  ok('底线词返回 null', b === null);
  ok('底线词不进 cues', st.cues.length === 1);
  ok('适配器持久化被调用', stored.length === 1);
  st.endCue(a);
  ok('endCue 补全 endMs', a.endMs != null);
}

console.log('== SubtitleTrack.export 自 cues ==');
{
  const st = new SubtitleTrack({ now: () => 0 });
  st.push({ speaker: 'xiaoya', text: '你好呀' });
  st.push({ speaker: 'user', text: '在吗' });
  const vtt = st.export('vtt');
  ok('导出含两条', (vtt.match(/：/g) || []).length === 2);
  ok('导出为字符串(非 Promise)', typeof vtt === 'string');
}

await new Promise((r) => setTimeout(r, 30));
console.log('\n==== SubtitleTrack 单测汇总 ====');
console.log('PASS=' + pass + '  FAIL=' + fail);
assert.strictEqual(fail, 0, '存在失败时断言终止');
process.exit(fail === 0 ? 0 : 1);
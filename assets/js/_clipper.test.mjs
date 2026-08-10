// Node 单测：ClipBest（REQ-CT-03） // NOSONAR
// 运行：node assets/js/_clipper.test.mjs
import assert from 'node:assert';
import { nearestEmotion, scoreCue, scanPeaks, makeCardMeta, ClipBest } from './clipper.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

const emotionLog = [
  { t: 0,    arousal: 0.2, affection: 0.5, jealousy: 0.1 },
  { t: 3000, arousal: 0.9, affection: 0.8, jealousy: 0.6 }, // 峰值附近
  { t: 7000, arousal: 0.3, affection: 0.4, jealousy: 0.0 }
];
const cues = [
  { startMs: 1000, endMs: 2500, speaker: 'xiaoya', text: '普通一句', emotionTag: 'neutral' },
  { startMs: 2800, endMs: 4200, speaker: 'xiaoya', text: '名场面！', emotionTag: 'affection' },
  { startMs: 6500, endMs: 8000, speaker: 'user', text: '再聊会儿', emotionTag: null }
];

console.log('== nearestEmotion 最近时间戳 ==');
{
  ok('命中 3000 附近', nearestEmotion(emotionLog, 2900).t === 3000);
  ok('空日志返回 null', nearestEmotion([], 100) === null);
}

console.log('== scoreCue 峰值打分 ==');
{
  const sPeak = scoreCue(cues[1], emotionLog);  // 近 arousal0.9/affection0.8/jealousy0.6
  const sLow = scoreCue(cues[0], emotionLog);   // 近 arousal0.2/affection0.5/jealousy0.1
  ok('峰值分更高', sPeak > sLow);
  ok('分值合理范围', sPeak > 0.5 && sPeak <= 1);
}

console.log('== scanPeaks TopK 排序 ==');
{
  const peaks = scanPeaks(cues, emotionLog, 2);
  ok('返回 2 条', peaks.length === 2);
  ok('按分数降序', peaks[0].score >= peaks[1].score);
  ok('峰值片段为"名场面"', peaks[0].cue.text === '名场面！');
  ok('含时间窗', Array.isArray(peaks[0].window) && peaks[0].window.length === 2);
  const all = scanPeaks(cues, emotionLog, 10);
  ok('topK 超出则全返', all.length === 3);
}

console.log('== makeCardMeta 名场面卡元数据 ==');
{
  const peaks = scanPeaks(cues, emotionLog, 1);
  const card = makeCardMeta(peaks[0]);
  ok('kind=card', card.kind === 'card');
  ok('含文本', card.text === '名场面！');
  ok('含时长', card.durationMs === 1400);
  ok('含得分', typeof card.score === 'number');
}

console.log('== ClipBest 类编排 ==');
{
  const cb = new ClipBest({ topK: 2 });
  ok('clip 代理 scanPeaks', cb.clip(cues, emotionLog).length === 2);
  ok('makeCard 代理', cb.makeCard(peaks0(cues, emotionLog)).kind === 'card');
}
function peaks0(c, log) { return scanPeaks(c, log, 1)[0]; }

await new Promise((r) => setTimeout(r, 30));
console.log('\n==== ClipBest 单测汇总 ====');
console.log('PASS=' + pass + '  FAIL=' + fail);
assert.strictEqual(fail, 0, '存在失败时断言终止');
process.exit(fail === 0 ? 0 : 1);
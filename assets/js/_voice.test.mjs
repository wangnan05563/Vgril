// Node 单测：VoiceEngine（REQ-VO-01/02/03） // NOSONAR
// 运行：node assets/js/_voice.test.mjs
import assert from 'node:assert';
import {
  emotionToStyleKey, mapEmotionToTTS, computeSpeechParams, splitSentences, VoiceEngine,
  AVAILABLE_VOICES, matchVoiceById
} from './voice.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

// 桩：默认放行 SafetyFilter
function stubSafety() {
  return { screen: (t) => ({ pass: true, text: t }) };
}

console.log('== emotionToStyleKey 四象限 ==');
{
  ok('吃醋+高唤起 → sharp', emotionToStyleKey({ jealousy: 0.6, arousal: 0.5 }) === 'sharp');
  ok('正价+高唤起 → excited', emotionToStyleKey({ valence: 0.5, arousal: 0.6 }) === 'excited');
  ok('正价 → warm', emotionToStyleKey({ valence: 0.4 }) === 'warm');
  ok('负价 → grumpy', emotionToStyleKey({ valence: -0.3 }) === 'grumpy');
  ok('中性 → neutral', emotionToStyleKey({}) === 'neutral');
}

console.log('== mapEmotionToTTS 风格派生 ==');
{
  const r = mapEmotionToTTS({ valence: 0.5, arousal: 0.6 });
  ok('返回 voice+style', !!r.voice && !!r.style);
  ok('正向高唤起映射 excited', r.styleKey === 'excited');
  ok('负价映射 grumpy', mapEmotionToTTS({ valence: -0.4 }).styleKey === 'grumpy');
}

console.log('== mapEmotionToTTS preferredVoice 覆盖 ==');
{
  const r = mapEmotionToTTS({ valence: 0.6, arousal: 0.7 }, undefined, 'zh-CN-YunjianNeural');
  ok('voice 被 preferredVoice 覆盖', r.voice === 'zh-CN-YunjianNeural');
  ok('style 仍由情绪派生（excited/cheerful）', r.styleKey === 'excited' && r.style === 'cheerful');
  const r2 = mapEmotionToTTS({}, undefined, 'zh-CN-YunxiNeural');
  ok('空情绪下 voice 也被覆盖', r2.voice === 'zh-CN-YunxiNeural');
  ok('空 preferredVoice 仍走情感映射', mapEmotionToTTS({ valence: 0.4 }).voice === 'zh-CN-XiaoyiNeural');
}

console.log('== AVAILABLE_VOICES 导出 ==');
{
  ok('导出了 AVAILABLE_VOICES 且非空', Array.isArray(AVAILABLE_VOICES) && AVAILABLE_VOICES.length >= 5);
  ok('含默认晓晓音色条目', AVAILABLE_VOICES.some(v => v.id === 'zh-CN-XiaoxiaoNeural' && v.browserMatch));
}

console.log('== matchVoiceById 离线命中本地语音 ==');
{
  const voices = [
    { name: 'Microsoft Huihui Online - Chinese (Mainland)', voiceURI: 'Huihui' },
    { name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', voiceURI: 'Xiaoxiao' },
    { name: 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)', voiceURI: 'Yunxi' }
  ];
  ok('按浏览器名命中晓晓', matchVoiceById(voices, 'zh-CN-XiaoxiaoNeural') === voices[1]);
  ok('按 voiceURI 命中云希', matchVoiceById(voices, 'zh-CN-YunxiNeural') === voices[2]);
  ok('无匹配返回 null', matchVoiceById(voices, 'zh-CN-YunhaoNeural') === null);
  ok('空输入返回 null', matchVoiceById(null, '') === null);
}

console.log('== computeSpeechParams 参数边界 ==');
{
  const p = computeSpeechParams({ arousal: 0.9, valence: 0.5 });
  ok('高唤起语速>1', p.rate > 1.0);
  ok('正价音高>1', p.pitch > 1.0);
  const g = computeSpeechParams({ arousal: 0.1 }, { tone: 'gentle' });
  ok('gentle 语速≤1', g.rate <= 1.0);
  const lo = computeSpeechParams({ arousal: 1.5, valence: 1.5 });
  ok('rate 不越上界 2.0', lo.rate <= 2.0);
  const hi = computeSpeechParams({ arousal: -1, valence: -1 });
  ok('pitch 不越下界 0.4', hi.pitch >= 0.4);
}

console.log('== splitSentences 断句 ==');
{
  const s = splitSentences('你好呀！今天开心吗？我不理你了。');
  ok('按标点切成 3 句', s.length === 3);
  ok('末句含句号', s[2].includes('。'));
  ok('空串返回空数组', splitSentences('').length === 0);
}

console.log('== speak 本地兜底（注入 synth 桩） ==');
{
  const spoken = [];
  const synth = { speak: (u) => spoken.push(u), cancel: () => {} };
  const ve = new VoiceEngine({ synth: synth, safety: stubSafety(), hooks: {} });
  const r = ve.speak('今天也辛苦了哦', { emotion: { valence: 0.5 } });
  ok('返回 Promise', typeof r.then === 'function');
  r.then((res) => {
    ok('本地模式标记', res.mode === 'local');
    ok('synth.speak 被调用', spoken.length === 1);
    ok('播报文本正确', spoken[0].text === '今天也辛苦了哦');
    ok('synth 桩区分有无 SpeechSynthesisUtterance', 'rate' in spoken[0]);
  });
}

console.log('== speak 增强模式走 ttsTransport ==');
{
  let captured = null;
  const ve = new VoiceEngine({
    mode: 'enhanced', ttsReady: true,
    ttsTransport: async (text, style) => { captured = { text, style }; return 'blob:audio-x'; },
    safety: stubSafety(), hooks: {}
  });
  ve.speak('我爱你', { emotion: { valence: 0.6, arousal: 0.7 } }).then((res) => {
    ok('增强模式标记', res.mode === 'enhanced');
    ok('仅当前文本出境（不含情绪原始向量）', captured.text === '我爱你' && !('valence' in captured.style));
    ok('style 已派生', !!captured.style.styleKey);
  });
}

console.log('== speak 增强模式优先用 preferredVoice ==');
{
  let captured = null;
  const ve = new VoiceEngine({
    mode: 'enhanced', ttsReady: true, preferredVoice: 'zh-CN-YunjianNeural',
    ttsTransport: async (text, style) => { captured = { text, style }; return 'blob:audio-y'; },
    safety: stubSafety(), hooks: {}
  });
  ve.speak('来运动吧', { emotion: { valence: 0.5, arousal: 0.6 } }).then((res) => {
    ok('增强模式标记', res.mode === 'enhanced');
    ok('出境 voice 为用户指定音色', captured.style.voice === 'zh-CN-YunjianNeural');
    ok('情绪 style 仍保留（excited）', captured.style.styleKey === 'excited');
  });
}

console.log('== speak 底线词拦截（D5 末端护栏） ==');
{
  const ve = new VoiceEngine({
    synth: { speak: () => {}, cancel: () => {} },
    safety: { screen: () => ({ pass: false, text: '█' }) },
    hooks: {}
  });
  ve.speak('违规内容', {}).then((res) => {
    ok('被拦截返回 blocked', res.blocked === true);
  });
}

console.log('== interrupt 打断（REQ-VO-02） ==');
{
  let cancelled = 0, aborted = 0;
  const ve = new VoiceEngine({
    synth: { speak: () => {}, cancel: () => { cancelled++; } },
    safety: stubSafety(),
    hooks: {}
  });
  ve._abort = { abort: () => { aborted++; } };
  ve._speaking = true;
  ve.interrupt();
  ok('speaking 复位', ve.isSpeaking() === false);
  ok('synth.cancel 被调用', cancelled === 1);
  ok('音频流 abort 被调用', aborted === 1);
}

console.log('== listen STT 快捷键（REQ-VO-03） ==');
{
  let started = false, onstartCb = null, onresultCb = null;
  const rec = {
    lang: '', start: () => { started = true; if (onstartCb) onstartCb(); },
    stop: () => {},
    set onstart(f) { onstartCb = f; }, get onstart() { return onstartCb; },
    set onresult(f) { onresultCb = f; }, get onresult() { return onresultCb; }
  };
  let interrupted = false;
  const ve = new VoiceEngine({
    synth: { speak: () => {}, cancel: () => { interrupted = true; } },
    recognitionFactory: () => rec, safety: stubSafety(), hooks: {}
  });
  ve._speaking = true;
  const r = ve.listen();
  ok('返回 recognition 实例', r === rec);
  ok('recognition.start 被调用', started === true);
  ok('开口即打断播报（onstart→interrupt）', interrupted === true);
  ok('speaking 复位', ve.isSpeaking() === false);
}

await new Promise((r) => setTimeout(r, 50));
console.log('\n==== VoiceEngine 单测汇总 ====');
console.log('PASS=' + pass + '  FAIL=' + fail);
assert.strictEqual(fail, 0, '存在失败时断言终止');
process.exit(fail === 0 ? 0 : 1);

/*
 * 赛博女友「小雅」(CodexQQSkin) — 语音子系统 VoiceEngine
 * 对应：REQ-VO-01（情感化 TTS）/ REQ-VO-02（流式可打断）/ REQ-VO-03（快捷键 STT）
 * 双模：浏览器 window.VoiceEngine；Node module.exports（纯逻辑可单测）
 *
 * 衔接契约（见《详细设计_M1》§6 + §0 安全约束）：
 *  - D1 隐私边界：增强模式仅当前轮文本经 /api/tts 出境；情绪不入参数出境（style 仅本地派生）。
 *  - D2 SSRF：tts endpoint 来自服务端 /api/config，ttsTransport 由外层注入，本模块不拼 URL。
 *  - D5 内容安全：播报前再经 SafetyFilter.screen 过滤一次（RESP 链路末端护栏）。
 *  - REQ-COMP-01：speak 入口统一挂 renderAIBadge（"由 AI 生成，非真人"水印）。
 *
 * 副作用（SpeechSynthesis / SpeechRecognition / 网络音频）全部经 opts 注入的适配器（synth /
 * recognitionFactory / ttsTransport / hooks），以便 Node 纯逻辑单测，浏览器侧给予浏览器原生实现。
 */
(function (global) {
  'use strict';

  // 情感 → 神经 TTS 的 voice/style 默认映射（与 assets/data/tts_emotion.json 同构；
  // 浏览器侧可传入更丰富的映射覆盖）。仅由 valence/arousal/jealousy 本地派生，绝不携带出境。
  var DEFAULT_TTS_MAP = {
    excited: { voice: 'zh-CN-XiaoxiaoNeural', style: 'cheerful' },
    warm:    { voice: 'zh-CN-XiaoyiNeural',   style: 'gentle' },
    sharp:   { voice: 'zh-CN-YunxiNeural',    style: 'angry' },
    grumpy:  { voice: 'zh-CN-YunyangNeural',  style: 'calm' },
    neutral: { voice: 'zh-CN-XiaoxiaoNeural', style: 'general' }
  };

  // 可选 Edge-TTS 中文神经音色清单（与微软 Edge 在线神经 TTS 同 ID）。
  // browserMatch：离线时用于在本地 SpeechSynthesis 可用语音中命中同名 Online 语音（无需服务端）。
  var AVAILABLE_VOICES = [
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声（默认）',      browserMatch: ['Xiaoxiao', '晓晓'] },
    { id: 'zh-CN-XiaoyiNeural',   label: '小艺 · 活泼女孩',              browserMatch: ['Xiaoyi', '小艺'] },
    { id: 'zh-CN-XiaohanNeural',  label: '晓涵 · 专业知性女声',          browserMatch: ['Xiaohan', '晓涵'] },
    { id: 'zh-CN-XiaomoNeural',   label: '晓墨 · 沉静读书女声',          browserMatch: ['Xiaomo', '晓墨'] },
    { id: 'zh-CN-XiaoruiNeural',  label: '晓睿 · 清亮新闻女声',          browserMatch: ['Xiaorui', '晓睿'] },
    { id: 'zh-CN-YunxiNeural',    label: '云希 · 阳光青年男声',          browserMatch: ['Yunxi', '云希'] },
    { id: 'zh-CN-YunyangNeural',  label: '云扬 · 沉稳男声（新闻/体育）', browserMatch: ['Yunyang', '云扬'] },
    { id: 'zh-CN-YunjianNeural',  label: '云健 · 动感运动男声',          browserMatch: ['Yunjian', '云健'] },
    { id: 'zh-CN-YunzeNeural',    label: '云泽 · 小说男声',              browserMatch: ['Yunze', '云泽'] },
    { id: 'zh-CN-YunhaoNeural',   label: '云皓 · 说唱男声',              browserMatch: ['Yunhao', '云皓'] }
  ];

  // ---- 纯函数 ----

  // 情感向量 → TTS 风格键（valence/arousal 四象限 + 吃醋偏置）
  function emotionToStyleKey(e) {
    e = e || {};
    var v = e.valence || 0;
    var a = e.arousal || 0;
    var j = e.jealousy || 0;
    if (j >= 0.5 && a >= 0.4) return 'sharp';     // 高唤起 + 吃醋 → 急促带刺
    if (v >= 0.3 && a >= 0.5) return 'excited';   // 正价 + 高唤起 → 兴奋
    if (v >= 0.3) return 'warm';                  // 正价 → 温柔
    if (v < -0.1 || j >= 0.4) return 'grumpy';    // 负价 / 吃醋 → 闷闷不乐
    return 'neutral';
  }

  // 情感 + 微调 → 神经 TTS 的 voice/style（供 /api/tts 请求体）
  // preferredVoice（可选）：手动指定的 Edge-TTS 音色 ID，覆盖情感映射的 voice，但保留情绪派生的 style。
  function mapEmotionToTTS(emotion, map, preferredVoice) {
    map = map || DEFAULT_TTS_MAP;
    var key = emotionToStyleKey(emotion);
    var hit = map[key] || map.neutral || { voice: 'default', style: 'general' };
    var voice = preferredVoice || hit.voice;
    return { styleKey: key, voice: voice, style: hit.style };
  }

  // 在浏览器可用语音列表中按 Edge-TTS 音色 ID 命中对应的 SpeechSynthesisVoice（离线可用；无则回退 null）。
  function matchVoiceById(voices, id) {
    if (!voices || !id) return null;
    var entry = null;
    for (var i = 0; i < AVAILABLE_VOICES.length; i++) {
      if (AVAILABLE_VOICES[i].id === id) { entry = AVAILABLE_VOICES[i]; break; }
    }
    var keys = (entry && entry.browserMatch) ? entry.browserMatch : [id];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      for (var j = 0; j < voices.length; j++) {
        var v = voices[j];
        var name = v.name || '';
        var uri = v.voiceURI || '';
        if (name.indexOf(key) !== -1 || uri.indexOf(key) !== -1) return v;
      }
    }
    // 退化：直接按音色 ID 子串匹配 voiceURI
    for (var m = 0; m < voices.length; m++) {
      if (voices[m].voiceURI && voices[m].voiceURI.indexOf(id) !== -1) return voices[m];
    }
    return null;
  }

  // 情感 + 微调 → 浏览器 SpeechSynthesis 的 rate/pitch/volume 参数（纯函数，离线兜底用）
  function computeSpeechParams(emotion, tune) {
    emotion = emotion || {};
    tune = tune || {};
    var v = emotion.valence || 0;
    var a = emotion.arousal || 0;
    var rate = 1.0;
    var pitch = 1.0;
    // 高唤起 → 语速更快；gentle 微调 → 略慢更软
    if (a >= 0.6) rate += 0.2;
    else if (a <= 0.2) rate -= 0.05;
    if (tune.tone === 'gentle') { rate -= 0.05; pitch += 0.05; }
    // 正价 → 音高略升；负价 → 略降（傲娇慍怒）
    pitch += v * 0.08;
    rate = Math.max(0.5, Math.min(2.0, rate));
    pitch = Math.max(0.4, Math.min(2.0, pitch));
    return { rate: Math.round(rate * 100) / 100, pitch: Math.round(pitch * 100) / 100, volume: 1.0 };
  }

  // 句子切分（流式播报 / 字幕落点用）：按中英文句末标点断句，保留标点
  function splitSentences(text) {
    if (!text) return [];
    var out = [];
    var buf = '';
    var marks = '。！？!?；;\n';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      buf += ch;
      if (marks.indexOf(ch) !== -1) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf.trim().length) out.push(buf);
    return out;
  }

  // ---- VoiceEngine 类（副作用经 opts 注入）----
  function VoiceEngine(opts) {
    opts = opts || {};
    this.mode = opts.mode || 'local';                 // 'local' | 'enhanced'
    this.ttsReady = !!opts.ttsReady;                  // 增强模式是否具备神经 TTS
    this.ttsTransport = opts.ttsTransport || null;    // async (text, styleObj) => audioUrl
    this.synth = opts.synth || (typeof window !== 'undefined' ? window.speechSynthesis : null);
    this.recognitionFactory = opts.recognitionFactory || null; // () => SpeechRecognition-like
    this.safety = opts.safety || (typeof window !== 'undefined' ? window.SafetyFilter : null);
    this.ttsMap = opts.ttsMap || DEFAULT_TTS_MAP;
    this.preferredVoice = opts.preferredVoice || null; // 手动指定的 Edge-TTS 音色 ID（覆盖情感映射）
    this.hooks = opts.hooks || {};                    // { onSubtitle, onAIBadge, onAudio, onUserSpeech }
    this._speaking = false;
    this._abort = null;
    this._recognition = null;
  }

  VoiceEngine.prototype.isSpeaking = function () { return this._speaking; };

  // REQ-VO-01 情感化播报（统一入口，挂 AI 水印）；返回 Promise
  VoiceEngine.prototype.speak = function (text, opts) {
    opts = opts || {};
    var self = this;
    var screened = this.safety ? this.safety.screen(text) : { pass: true, text: text };
    if (!screened.pass) return Promise.resolve({ blocked: true });
    var safeText = screened.text || '';
    if (this.hooks.onAIBadge) this.hooks.onAIBadge('voice'); // REQ-COMP-01
    this._speaking = true;

    if (this.mode === 'enhanced' && this.ttsReady && this.ttsTransport) {
      var style = mapEmotionToTTS(opts.emotion, this.ttsMap, this.preferredVoice);
      var ac = new AbortController();
      this._abort = ac;
      return Promise.resolve(this.ttsTransport(safeText, style, ac.signal))
        .then(function (url) {
          if (self.hooks.onAudio) self.hooks.onAudio(url, safeText);
          if (self.hooks.onSubtitle) self.hooks.onSubtitle(safeText);
          self._speaking = false;
          return { mode: 'enhanced', audio: url };
        })
        .catch(function () {
          // 神经 TTS 失败 → 兜底本地播报
          return self.speakLocal(safeText, opts);
        });
    }
    return Promise.resolve(this.speakLocal(safeText, opts));
  };

  // 本地兜底播报（浏览器 SpeechSynthesis；Node 下走注入的 synth 桩）
  VoiceEngine.prototype.speakLocal = function (text, opts) {
    opts = opts || {};
    var params = computeSpeechParams(opts.emotion, opts.tune);
    var U;
    if (typeof SpeechSynthesisUtterance !== 'undefined') {
      U = new SpeechSynthesisUtterance(text);
      U.rate = params.rate; U.pitch = params.pitch; U.volume = params.volume;
    } else {
      // Node / 无原生实现：构造纯对象供 synth 桩消费
      U = { text: text, rate: params.rate, pitch: params.pitch, volume: params.volume };
    }
    if (this.synth && typeof this.synth.speak === 'function') this.synth.speak(U);
    if (this.hooks.onSubtitle) this.hooks.onSubtitle(text);
    this._speaking = false;
    return { mode: 'local', params: params };
  };

  // REQ-VO-02 流式可打断：中止神经音频流 + 取消浏览器 TTS
  VoiceEngine.prototype.interrupt = function () {
    this._speaking = false;
    if (this._abort && typeof this._abort.abort === 'function') {
      try { this._abort.abort(); } catch (e) {}
      this._abort = null;
    }
    if (this.synth && typeof this.synth.cancel === 'function') {
      this.synth.cancel();
    }
    return true;
  };

  // REQ-VO-03 快捷键唤起 STT：开口即打断当前播报（联动 interrupt）
  VoiceEngine.prototype.listen = function () {
    if (!this.recognitionFactory) return null;
    var self = this;
    var rec = this.recognitionFactory();
    if (!rec) return null;
    rec.lang = rec.lang || 'zh-CN';
    rec.onstart = function () { self.interrupt(); }; // 用户开口 → 打断播报
    rec.onresult = function (e) {
      var results = e && e.results;
      if (self.hooks.onUserSpeech) self.hooks.onUserSpeech(results);
    };
    if (typeof rec.start === 'function') rec.start();
    this._recognition = rec;
    return rec;
  };

  VoiceEngine.prototype.stopListen = function () {
    if (this._recognition && typeof this._recognition.stop === 'function') {
      this._recognition.stop();
    }
    this._recognition = null;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_TTS_MAP: DEFAULT_TTS_MAP,
      AVAILABLE_VOICES: AVAILABLE_VOICES,
      emotionToStyleKey: emotionToStyleKey,
      mapEmotionToTTS: mapEmotionToTTS,
      matchVoiceById: matchVoiceById,
      computeSpeechParams: computeSpeechParams,
      splitSentences: splitSentences,
      VoiceEngine: VoiceEngine
    };
  } else {
    global.VoiceEngine = VoiceEngine;
    global.XiaoyaVoice = {
      DEFAULT_TTS_MAP: DEFAULT_TTS_MAP,
      AVAILABLE_VOICES: AVAILABLE_VOICES,
      emotionToStyleKey: emotionToStyleKey,
      mapEmotionToTTS: mapEmotionToTTS,
      matchVoiceById: matchVoiceById,
      computeSpeechParams: computeSpeechParams,
      splitSentences: splitSentences,
      VoiceEngine: VoiceEngine
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

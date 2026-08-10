/*
 * 赛博女友「小雅」(CodexQQSkin) — 片段精选 ClipBest
 * 对应：REQ-CT-03（情绪/关键词峰值标记 → 短视频/图文卡）
 * 双模：浏览器 window.ClipBest；Node module.exports（纯逻辑可单测）
 *
 * 衔接契约（见《详细设计_M2》§5 + §0 安全约束）：
 *  - D5/D3 分享前安检：makeCard / cutVideo 的成品文本须先经 SafetyFilter.screen；
 *    命中底线词或重叠危机干预时段 → 阻止分享（见 studio.js classifyShare）。
 *  - 峰值打分仅依赖本地情绪日志与字幕时间窗，不触网、不出境（D1）。
 *  - 无录屏时生成"名场面卡"元数据（文本+情绪标签+时长），PNG 渲染为浏览器侧职责，本模块仅产出描述符。
 */
(function (global) {
  'use strict';

  // 在情绪日志中找时间戳最接近 ms 的一条
  function nearestEmotion(emotionLog, ms) {
    emotionLog = emotionLog || [];
    if (!emotionLog.length) return null;
    var best = null, bestDiff = Infinity;
    for (var i = 0; i < emotionLog.length; i++) {
      var e = emotionLog[i];
      var t = (e && typeof e.t !== 'undefined') ? e.t : (e && e.at ? new Date(e.at).getTime() : 0);
      var diff = Math.abs(t - ms);
      if (diff < bestDiff) { bestDiff = diff; best = e; }
    }
    return best;
  }

  // 单条 cue 的情绪强度得分（高 arousal / 高 affection / 尖刺 jealousy = 有趣瞬间）
  function scoreCue(cue, emotionLog) {
    var e = nearestEmotion(emotionLog, cue.startMs || 0) || {};
    var arousal = e.arousal || 0;
    var affection = e.affection || 0;
    var jealousy = e.jealousy || 0;
    return Math.max(0, arousal * 0.4 + affection * 0.3 + jealousy * 0.3);
  }

  // 峰值扫描：返回 TopK 情绪峰值片段（含时间窗）
  function scanPeaks(cues, emotionLog, topK) {
    cues = cues || [];
    topK = topK || 3;
    var scored = cues.map(function (c) {
      var s = scoreCue(c, emotionLog);
      return { cue: c, score: s, window: [c.startMs || 0, c.endMs || ((c.startMs || 0) + 1500)] };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, topK);
  }

  // 名场面卡元数据（PNG 渲染交给浏览器；这里产出描述符，便于单测与序列化）
  function makeCardMeta(peak) {
    peak = peak || {};
    var c = peak.cue || {};
    var start = c.startMs || 0;
    var end = c.endMs || (start + 1500);
    return {
      kind: 'card',
      text: c.text || '',
      emotionTag: c.emotionTag || null,
      durationMs: Math.max(1, end - start),
      score: peak.score || 0
    };
  }

  // ---- ClipBest 类 ----
  function ClipBest(opts) {
    opts = opts || {};
    this.topK = opts.topK || 3;
  }

  ClipBest.prototype.clip = function (cues, emotionLog, topK) {
    return scanPeaks(cues, emotionLog, topK || this.topK);
  };

  ClipBest.prototype.makeCard = function (peak) {
    return makeCardMeta(peak);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      nearestEmotion: nearestEmotion,
      scoreCue: scoreCue,
      scanPeaks: scanPeaks,
      makeCardMeta: makeCardMeta,
      ClipBest: ClipBest
    };
  } else {
    global.ClipBest = ClipBest;
    global.XiaoyaClip = {
      nearestEmotion: nearestEmotion, scoreCue: scoreCue, scanPeaks: scanPeaks,
      makeCardMeta: makeCardMeta, ClipBest: ClipBest
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

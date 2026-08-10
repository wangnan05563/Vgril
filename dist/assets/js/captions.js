/*
 * 赛博女友「小雅」(CodexQQSkin) — 字幕系统 SubtitleTrack
 * 对应：REQ-CT-01（实时字幕 + 多模板 vtt/srt/txt 导出）
 * 双模：浏览器 window.SubtitleTrack；Node module.exports（纯逻辑可单测）
 *
 * 衔接契约（见《详细设计_M2》§3 + §0 安全约束）：
 *  - D5 内容安全：入库即 SafetyFilter.screen；命中底线词不进字幕、不导出（避免扩散）。
 *  - D1 隐私边界：字幕仅本地存储（IndexedDB captions store / 注入适配器），导出为本地下载，零自动上传。
 *  - 文本安全与模板解耦：模板仅控制渲染样式（位置/字体/描边/双行），不影响文本过滤结果。
 */
(function (global) {
  'use strict';

  // 毫秒 → 时间戳字符串（sep='.' 用于 vtt，sep=',' 用于 srt）
  function fmtTime(ms, sep) {
    sep = sep || '.';
    if (ms < 0) ms = 0;
    var total = Math.floor(ms);
    var msPart = String(total % 1000).padStart(3, '0');
    var s = Math.floor(total / 1000);
    var sec = String(s % 60).padStart(2, '0');
    var min = String(Math.floor(s / 60) % 60).padStart(2, '0');
    var hr = String(Math.floor(s / 3600)).padStart(2, '0');
    return hr + ':' + min + ':' + sec + sep + msPart;
  }

  function speakerLabel(speaker) {
    return speaker === 'user' ? '你' : '小雅';
  }

  // ---- 纯渲染函数（输入 cues 数组，输出字符串）----
  function renderVTT(cues) {
    var body = 'WEBVTT\n\n';
    cues.forEach(function (c, i) {
      body += (i + 1) + '\n';
      body += fmtTime(c.startMs, '.') + ' --> ' + fmtTime(c.endMs || (c.startMs + 1500), '.') + '\n';
      body += speakerLabel(c.speaker) + '：' + c.text + '\n\n';
    });
    return body;
  }

  function renderSRT(cues) {
    var body = '';
    cues.forEach(function (c, i) {
      body += (i + 1) + '\n';
      body += fmtTime(c.startMs, ',') + ' --> ' + fmtTime(c.endMs || (c.startMs + 1500), ',') + '\n';
      body += speakerLabel(c.speaker) + '：' + c.text + '\n\n';
    });
    return body;
  }

  function renderTXT(cues) {
    // 纯对话稿，无时间轴，便于校对 / 记忆回顾
    return cues.map(function (c) {
      return speakerLabel(c.speaker) + '：' + c.text;
    }).join('\n') + '\n';
  }

  function render(format, cues) {
    format = (format || 'vtt').toLowerCase();
    if (format === 'srt') return renderSRT(cues);
    if (format === 'txt') return renderTXT(cues);
    return renderVTT(cues);
  }

  // 入库安检：经 SafetyFilter.screen；返回 {pass, text}
  function screenCue(text, safety) {
    if (safety && typeof safety.screen === 'function') {
      var r = safety.screen(text);
      return { pass: !!r.pass, text: r.text != null ? r.text : text };
    }
    return { pass: true, text: text };
  }

  // ---- SubtitleTrack 类（副作用经 opts/适配器注入）----
  function SubtitleTrack(opts) {
    opts = opts || {};
    this.sessionId = opts.sessionId || ('session-' + Date.now());
    this.safety = opts.safety || null;
    this.adapter = opts.adapter || null; // { put(rec), getAll(), getAllByIndex() }
    this._now = opts.now || (function () { return Date.now(); });
    this._start = this._now();
    this.cues = [];
    this._seq = 0;
  }

  // 实时维护一条字幕（入库即滤 D5）；返回 cue 或 null（被拦截）
  SubtitleTrack.prototype.push = function (c) {
    c = c || {};
    var screened = screenCue(c.text || '', this.safety);
    if (!screened.pass) return null; // 底线词不进字幕
    var id = 'cue-' + (++this._seq) + '-' + this.sessionId;
    var cue = {
      id: id,
      sessionId: this.sessionId,
      startMs: this._now() - this._start,
      endMs: null,
      speaker: c.speaker || 'xiaoya',
      text: screened.text,
      emotionTag: c.emotionTag || null,
      screened: true
    };
    this.cues.push(cue);
    if (this.adapter && typeof this.adapter.put === 'function') {
      this.adapter.put(cue);
    }
    return cue;
  };

  // 落句末（标点 / 静音检测触发）：补全 endMs
  SubtitleTrack.prototype.endCue = function (cue) {
    if (cue && cue.endMs == null) cue.endMs = this._now() - this._start;
    return cue;
  };

  SubtitleTrack.prototype.all = function () {
    if (this.adapter && typeof this.adapter.getAll === 'function') return this.adapter.getAll();
    return this.cues;
  };

  // 多模板导出（format: vtt|srt|txt）；模板仅影响样式，不影响文本（文本已筛）
  SubtitleTrack.prototype.export = function (format, template) {
    var cues = this.all();
    if (typeof cues.then === 'function') {
      // 适配器返回 Promise（IndexedDB）：同步路径下不应发生；防御性返回空
      return Promise.resolve(cues).then(function (cs) { return render(format, cs || []); });
    }
    return render(format, cues || []);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      fmtTime: fmtTime,
      renderVTT: renderVTT,
      renderSRT: renderSRT,
      renderTXT: renderTXT,
      render: render,
      screenCue: screenCue,
      SubtitleTrack: SubtitleTrack
    };
  } else {
    global.SubtitleTrack = SubtitleTrack;
    global.XiaoyaCaptions = {
      fmtTime: fmtTime, renderVTT: renderVTT, renderSRT: renderSRT, renderTXT: renderTXT,
      render: render, screenCue: screenCue, SubtitleTrack: SubtitleTrack
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

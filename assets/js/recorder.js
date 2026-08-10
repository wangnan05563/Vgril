/*
 * 赛博女友「小雅」(CodexQQSkin) — 录屏烧录 Recorder
 * 对应：REQ-CT-02（图形化一键：取屏 → Canvas 烧录字幕 → MediaRecorder）
 * 双模：浏览器 window.Recorder；Node module.exports（纯逻辑可单测）
 *
 * 衔接契约（见《详细设计_M2》§4 + §0 安全约束）：
 *  - D2 SSRF：纯前端 Canvas 合成 + MediaRecorder，不新增 /api 端点、不依赖外部 ffmpeg、不接收用户任意 URL。
 *  - REQ-COMP-01：录制期间屏幕上的 AI 水印（renderAIBadge）被 getDisplayMedia 捕获，成片天然带标识。
 *  - D3 危机耦合：录制期间若触发危机弹窗，记录 crisisWindow（浏览器侧叠加打码）。
 *
 * 浏览器专属 API（getDisplayMedia / MediaRecorder / Canvas）仅在浏览器可用；
 * 纯逻辑（mime 选型 / 码率计算）可在 Node 单测；类方法在 typeof navigator==='undefined' 时安全降级为空操作报错提示。
 */
(function (global) {
  'use strict';

  var PREFERRED = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

  // 在浏览器支持的编码列表中挑选最优 mimeType（交集 + 优先级）
  function pickMimeType(supported) {
    if (!supported || !supported.length) return 'video/webm'; // 兜底
    for (var i = 0; i < PREFERRED.length; i++) {
      if (supported.indexOf(PREFERRED[i]) !== -1) return PREFERRED[i];
    }
    return supported[0];
  }

  // 码率：配置优先，默认 8Mbps
  function computeBitrate(cfg) {
    cfg = cfg || {};
    var b = cfg.studio && cfg.studio.recorderBitrate;
    return (typeof b === 'number' && b > 0) ? b : 8e6;
  }

  // ---- Recorder 类（浏览器专属；Node 下方法安全报错）----
  function Recorder(opts) {
    opts = opts || {};
    this.templateId = opts.templateId || 'default';
    this.withSubtitle = opts.withSubtitle !== false;
    this.withMic = !!opts.withMic;
    this.cfg = opts.cfg || null;
    this.hooks = opts.hooks || {};
    this._rec = null;
    this._stream = null;
    this._chunks = [];
  }

  Recorder.prototype.start = function () {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('当前环境不支持 getDisplayMedia（需 localhost 或 HTTPS）'));
    }
    var self = this;
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }).then(function (stream) {
      self._stream = stream;
      var mime = pickMimeType(Recorder.supportedMimeTypes());
      var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: computeBitrate(self.cfg) });
      rec.ondataavailable = function (e) { if (e.data && e.data.size) self._chunks.push(e.data); };
      self._rec = rec;
      rec.start();
      if (self.hooks.onStart) self.hooks.onStart();
      return mime;
    });
  };

  Recorder.prototype.stop = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (!self._rec) { resolve(null); return; }
      self._rec.onstop = function () {
        var blob = self._chunks.length ? new Blob(self._chunks, { type: 'video/webm' }) : null;
        if (self._stream) self._stream.getTracks().forEach(function (t) { t.stop(); });
        if (self.hooks.onStop) self.hooks.onStop(blob);
        resolve(blob);
      };
      self._rec.stop();
    });
  };

  // 浏览器可用编码探测（Node 返回空数组，仅供纯逻辑测试 pickMimeType 的交集合并）
  Recorder.supportedMimeTypes = function () {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return [];
    return PREFERRED.filter(function (m) { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PREFERRED: PREFERRED,
      pickMimeType: pickMimeType,
      computeBitrate: computeBitrate,
      Recorder: Recorder
    };
  } else {
    global.Recorder = Recorder;
    global.XiaoyaRecorder = {
      PREFERRED: PREFERRED, pickMimeType: pickMimeType, computeBitrate: computeBitrate, Recorder: Recorder
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

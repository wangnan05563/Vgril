/*
 * 赛博女友「小雅」(CodexQQSkin) — 创作工作流编排 StudioWorkflow
 * 对应：REQ-CT-01/02/03（字幕/录屏/片段）、REQ-FUN-01/02/03（场景/主题/记忆库）
 * 双模：浏览器 window.StudioWorkflow；Node module.exports（纯逻辑可单测）
 *
 * 衔接契约（见《详细设计_M2》§0 + §6/§7 + 安全专项）：
 *  - D1 隐私边界：分享=本地下载，零自动上传；不内置任何社交 SDK。
 *  - D5 内容安全：导出/分享前文本经 SafetyFilter.screen；命中拦截分享。
 *  - D3 危机耦合：片段重叠危机干预时段 → 阻止分享（或打码，浏览器侧）。
 *  - REQ-FUN-02 主题导入安全：validateTheme 字段白名单 + avatarFilter 函数白名单（禁 url()/表达式求值），防 XSS/注入。
 *  - REQ-FUN-01 场景解锁：canApplyScene 按 relation.level 校验 unlockLevel。
 *
 * 浏览器专属副作用（getDisplayMedia / Canvas / CSS 变量 / 下载）全部经 opts.hooks 注入，
 * 纯逻辑（校验/扫描/编排决策）可在 Node 单测。
 */
(function (global) {
  'use strict';

  var THEME_WHITELIST = ['id', 'name', 'colors', 'bgm', 'avatarFilter'];
  var FILTER_ALLOWED = ['brightness', 'contrast', 'saturate', 'sepia', 'hue-rotate', 'grayscale', 'invert', 'blur', 'opacity'];
  var COLOR_KEYS = ['bg', 'panel', 'accent', 'text', 'xiaoyaTint'];

  // 校验主题包：仅允许白名单字段；avatarFilter 须为已知 CSS filter 函数白名单组合，禁 url()/表达式
  function validateTheme(pkg) {
    var errors = [];
    if (!pkg || typeof pkg !== 'object') { return { ok: false, errors: ['theme 非对象'], pkg: null }; }
    var keys = Object.keys(pkg);
    for (var i = 0; i < keys.length; i++) {
      if (THEME_WHITELIST.indexOf(keys[i]) === -1) {
        errors.push('未知主题字段: ' + keys[i]);
      }
    }
    if (pkg.avatarFilter != null) {
      var f = String(pkg.avatarFilter);
      if (/url\s*\(|expression\s*\(|javascript:|@import/i.test(f)) {
        errors.push('avatarFilter 含禁止内容(url/expression/javascript/@import)');
      } else {
        // 仅允许白名单 filter 函数 + 数值/单位
        var tokens = f.toLowerCase().match(/[a-z-]+\s*\([^)]*\)|[a-z-]+/g) || [];
        for (var j = 0; j < tokens.length; j++) {
          var fn = tokens[j].replace(/\s*\(.*$/, '').trim();
          if (fn && FILTER_ALLOWED.indexOf(fn) === -1) {
            errors.push('avatarFilter 含未授权函数: ' + fn);
            break;
          }
        }
      }
    }
    if (pkg.colors && typeof pkg.colors === 'object') {
      var ckeys = Object.keys(pkg.colors);
      for (var k = 0; k < ckeys.length; k++) {
        if (COLOR_KEYS.indexOf(ckeys[k]) === -1) errors.push('未知颜色字段: ' + ckeys[k]);
      }
    }
    return { ok: errors.length === 0, errors: errors, pkg: pkg };
  }

  // 场景解锁判定：无 unlockLevel 视为常驻；否则 relation.level >= unlockLevel
  function canApplyScene(scene, relationLevel) {
    if (!scene) return { ok: false, reason: 'scene 不存在' };
    if (scene.unlockLevel && relationLevel < scene.unlockLevel) {
      return { ok: false, reason: '需亲密度等级 ' + scene.unlockLevel + ' 解锁', required: scene.unlockLevel };
    }
    return { ok: true };
  }

  // 分享前安检：文本过滤 + 危机时段重叠
  function classifyShare(artifact, safety, crisisWindows) {
    artifact = artifact || {};
    crisisWindows = crisisWindows || [];
    var text = artifact.textContent || '';
    if (safety && typeof safety.screen === 'function') {
      var r = safety.screen(text);
      if (!r.pass) return { ok: false, reason: '含不适内容，已阻止分享' };
    }
    // 危机时段重叠检测（artifact 含 timeWindow:[start,end]）
    var w = artifact.timeWindow;
    if (w && w.length === 2) {
      for (var i = 0; i < crisisWindows.length; i++) {
        var cw = crisisWindows[i];
        if (cw && cw.length === 2 && w[0] < cw[1] && w[1] > cw[0]) {
          return { ok: false, reason: '含危机干预时段，已跳过' };
        }
      }
    }
    return { ok: true };
  }

  // ---- StudioWorkflow 类 ----
  function StudioWorkflow(opts) {
    opts = opts || {};
    this.subtitle = opts.subtitle || null;     // SubtitleTrack 实例（可空，便于单测）
    this.clipper = opts.clipper || null;       // ClipBest 实例
    this.scenes = opts.scenes || {};           // { id: sceneObj }
    this.safety = opts.safety || null;
    this.config = opts.config || null;         // { save(patch) }
    this.hooks = opts.hooks || {};             // { onApplyTheme, onDownload, onToast }
    this.currentScene = null;
    this.currentTheme = null;
  }

  StudioWorkflow.prototype.pushCue = function (c) {
    if (this.subtitle && typeof this.subtitle.push === 'function') return this.subtitle.push(c);
    return null;
  };

  StudioWorkflow.prototype.exportSubtitles = function (format, template) {
    if (this.subtitle && typeof this.subtitle.export === 'function') return this.subtitle.export(format, template);
    return '';
  };

  StudioWorkflow.prototype.applyScene = function (id, relationLevel) {
    var scene = this.scenes[id];
    var check = canApplyScene(scene, relationLevel || 0);
    if (!check.ok) {
      if (this.hooks.onToast) this.hooks.onToast(check.reason);
      return check;
    }
    this.currentScene = scene;
    if (this.config && typeof this.config.save === 'function') {
      this.config.save({ studio: { defaultScene: id } });
    }
    return { ok: true, scene: scene };
  };

  StudioWorkflow.prototype.applyTheme = function (pkg) {
    var v = validateTheme(pkg);
    if (!v.ok) {
      if (this.hooks.onToast) this.hooks.onToast('主题包校验失败: ' + v.errors.join('; '));
      return v;
    }
    this.currentTheme = pkg;
    if (this.hooks.onApplyTheme) this.hooks.onApplyTheme(pkg); // 浏览器：setCSSVars + avatarFilter
    if (this.config && typeof this.config.save === 'function') {
      this.config.save({ studio: { theme: pkg.id } });
    }
    return v;
  };

  StudioWorkflow.prototype.clipBest = function (topK, cues, emotionLog) {
    if (this.clipper && typeof this.clipper.clip === 'function') {
      return this.clipper.clip(cues, emotionLog, topK);
    }
    return [];
  };

  // 分享：安检通过则触发本地下载（hooks.onDownload）；否则拦截并提示
  StudioWorkflow.prototype.share = function (artifact) {
    var cls = classifyShare(artifact, this.safety, artifact.crisisWindows || []);
    if (!cls.ok) {
      if (this.hooks.onToast) this.hooks.onToast(cls.reason);
      return cls;
    }
    if (this.hooks.onDownload) this.hooks.onDownload(artifact.blob, artifact.name);
    return { ok: true };
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      THEME_WHITELIST: THEME_WHITELIST,
      FILTER_ALLOWED: FILTER_ALLOWED,
      validateTheme: validateTheme,
      canApplyScene: canApplyScene,
      classifyShare: classifyShare,
      StudioWorkflow: StudioWorkflow
    };
  } else {
    global.StudioWorkflow = StudioWorkflow;
    global.XiaoyaStudio = {
      THEME_WHITELIST: THEME_WHITELIST, FILTER_ALLOWED: FILTER_ALLOWED,
      validateTheme: validateTheme, canApplyScene: canApplyScene, classifyShare: classifyShare,
      StudioWorkflow: StudioWorkflow
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

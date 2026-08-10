/* ===================== 赛博女友 · 小雅 人设对话引擎 ===================== */
const SELF = "小雅";

/* ---------- 大模型接入（可选） ----------
   留空则使用内置"傲娇人设引擎"。填上后自动改走真实大模型。
   支持 OpenAI / DeepSeek / 任意 OpenAI 兼容接口。 */
const LLM = {
  enabled: false,
  endpoint: "https://api.deepseek.com/v1/chat/completions",
  apiKey: "",   // 在此填入你的 API Key
  model: "deepseek-chat",
  // 人设系统提示词（吃醋 / 傲娇 / 口语化 的人设底座）
  system: "你是赛博女友小雅。傲娇、敏感、爱吃醋；说话口语化、带点小脾气；"+
          "等用户久了会委屈；偶尔闹情绪但很快被哄好。用简短可爱的中文回复，不要长篇大论。"
};

async function fetchLLM(userText){
  if(!LLM.enabled || !LLM.apiKey) return null;
  const payload={model:LLM.model, messages:[
    {role:"system",content:LLM.system},
    {role:"user",content:userText}], temperature:0.9};
  try{
    let r;
    if(location.protocol==="file:"){
      r=await fetch(LLM.endpoint,{method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+LLM.apiKey},
        body:JSON.stringify(payload)});
    }else{
      // 经本地代理 /api/llm 转发，规避浏览器直连大模型接口的 CORS 限制。
      // 契约变更（SSRF 整改 D2）：endpoint / key 由设置面板经 /api/config 持久化到
      // 服务端 CONFIG（xiaoya_config.json），不再经客户端请求头下发，避免服务端被当开放代理跳板。
      r=await fetch("/api/llm",{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload)});
    }
    if(!r.ok) throw new Error("HTTP "+r.status);
    const d=await r.json();
    return d?.choices?.[0]?.message?.content?.trim() || null;
  }catch(e){ console.warn("LLM 调用失败，回退本地引擎",e); toast("⚠️ 大模型调用失败，已回退本地引擎"); return null; }
}
const $ = s => document.querySelector(s);
const messagesEl = $("#messages");
const inputEl = $("#input");
const stageEl = document.querySelector(".stage");
const capEl = $("#caption");
let captions=[], capOpen=null;
let _speechToken=0, _activeSpeech=null;  // 播报令牌：连发时新播报抢占并干净终止旧动画/语音（不误清字幕）
function startCap(t){ if(capOpen){capOpen.end=Date.now();captions.push(capOpen);} capOpen={start:Date.now(),end:null,text:t}; capEl.textContent=t; capEl.classList.add("show");
  // 同步进模块化 SubtitleTrack（设计包 M2 REQ-CT-01：本地累积，供创作面板导出；库内已含 SafetyFilter 末端安检）
  if(window.Xiaoya && window.Xiaoya.subtitle){ try{ window.Xiaoya.subtitle.push({speaker:"xiaoya",text:t}); }catch(e){} }
  fsPush("bot", t);   // 全屏模式：左侧无框渐隐字幕
}
function endCap(){ if(capOpen){capOpen.end=Date.now();captions.push(capOpen);capOpen=null;} capEl.classList.remove("show"); }

let lastActive = Date.now();   // 上次互动时间（用于"等久了会委屈"）
let ttsOn = true;              // 语音播报开关
let ttsRate = 1.02;            // 语音语速
let ttsPitch = 1.15;           // 语音音调
let voiceZh = null;            // 中文语音

/* ---------- 工具函数 ---------- */
function toast(t){const e=$("#toast");e.textContent=t;e.classList.add("show");clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove("show"),2200);}
function scrollBottom(){messagesEl.scrollTop=messagesEl.scrollHeight;}

function addMsg(who, text){
  const wrap=document.createElement("div");
  wrap.className="msg"+(who==="user"?" user":"");
  const av = who==="user"
    ? '<div class="av" style="background:#a974ff;display:grid;place-items:center;color:#fff;font-weight:800">你</div>'
    : '<img class="av" src="xiaoya.png" alt=""/>';
  const name = who==="user"?"你":SELF;
  wrap.innerHTML = av + `<div><div class="name">${name}</div><div class="bubble"></div></div>`;
  wrap.querySelector(".bubble").textContent = text;
  messagesEl.appendChild(wrap);
  scrollBottom();
  logMemory(who,text);   // 每次对话落记忆库（合并原 addMsg 包装逻辑，去掉函数重赋值）
  return wrap;
}

function setMood(emoji,label,tag){
  $("#moodEmoji").textContent=emoji;
  $("#moodPill").textContent="MOOD: "+label;
  $("#moodTag").textContent=tag;
}

/* ---------- 语音合成（TTS） ---------- */
function pickZhVoice(){
  const vs = speechSynthesis.getVoices();
  voiceZh = vs.find(v=>/zh|cmn|Chinese/i.test(v.lang+v.name)) || vs.find(v=>/zh/i.test(v.lang)) || null;
}
if('speechSynthesis' in window){ speechSynthesis.onvoiceschanged=pickZhVoice; pickZhVoice(); }
/* 用户手动指定 Edge-TTS 音色时，在本地 SpeechSynthesis 可用语音中命中同名 Online 语音（离线可用） */
function pickEdgeVoice(){
  const id=settings.edgeVoice;
  if(!id || !('speechSynthesis' in window) || !window.XiaoyaVoice) return null;
  return window.XiaoyaVoice.matchVoiceById(speechSynthesis.getVoices(), id);
}
/* 朗读 + 实时字幕（即使关闭 TTS，字幕也会显示，方便录屏） */
function renderAIBadge(){ const b=document.getElementById("aiBadge"); if(b) b.classList.add("show"); } // REQ-COMP-01
function hideAIBadge(){ const b=document.getElementById("aiBadge"); if(b) b.classList.remove("show"); }
function speak(text){
  if(_activeSpeech){ _activeSpeech.abort(); _activeSpeech=null; }  // 抢占上一段（stopOnly 不误清字幕）
  const my = ++_speechToken;
  renderAIBadge(); // 语音输出即挂"由 AI 生成"水印（REQ-COMP-01）；字幕由 digitalHumanSpeak 统一 startCap，避免重复写入
  if(ttsOn && 'speechSynthesis' in window){
    const u=new SpeechSynthesisUtterance(text);
    u.lang="zh-CN"; u.rate=ttsRate; u.pitch=ttsPitch; // 语速/音调可在设置里调
    const ev=pickEdgeVoice();                       // 优先用用户指定的 Edge-TTS 音色（离线命中本地 Online 语音）
    if(ev) u.voice=ev; else if(voiceZh) u.voice=voiceZh;
    u.onstart=()=>{ if(my!==_speechToken) return; stageEl.classList.add("speaking"); };
    u.onend=()=>{ if(my!==_speechToken) return; stageEl.classList.remove("speaking"); endCap(); hideAIBadge(); };
    u.onerror=()=>{ if(my!==_speechToken) return; stageEl.classList.remove("speaking"); endCap(); hideAIBadge(); };
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }else{
    stageEl.classList.add("speaking");
    const dur=Math.max(1200,text.length*180);
    setTimeout(()=>{ if(my!==_speechToken) return; stageEl.classList.remove("speaking"); endCap(); hideAIBadge(); },dur);
  }
}

/* ---------- 字幕导出（WebVTT / SRT） ---------- */
function fmtTime(ms,sep){
  const d=new Date(ms);
  const p=n=>String(n).padStart(2,"0");
  return "00:"+p(d.getMinutes())+":"+p(d.getSeconds())+sep+String(d.getMilliseconds()).padStart(3,"0");
}
function buildVTT(){
  const base=captions[0]?.start||0; let s="WEBVTT\n\n";
  captions.forEach((c,i)=>{
    const st=c.start-base, en=(c.end||c.start+1500)-base;
    s+=(i+1)+"\n"+fmtTime(st,".")+" --> "+fmtTime(en,".")+"\n"+c.text+"\n\n";
  });
  return s;
}
function buildSRT(){
  const base=captions[0]?.start||0; let s="";
  captions.forEach((c,i)=>{
    const st=c.start-base, en=(c.end||c.start+1500)-base;
    s+=(i+1)+"\n"+fmtTime(st,",")+" --> "+fmtTime(en,",")+"\n"+c.text+"\n\n";
  });
  return s;
}
function downloadFile(name,content,type){
  const b=new Blob([content],{type}); const u=URL.createObjectURL(b);
  const a=document.createElement("a"); a.href=u; a.download=name; a.click();
  URL.revokeObjectURL(u);
}
$("#subExport").addEventListener("click",()=>{
  if(!captions.length){ toast("还没有字幕，先和小雅聊几句～"); return; }
  // 同 tick 内连续 downloadFile 常被浏览器拦截第二个；错峰触发确保两份都落地
  downloadFile("xiaoya_subtitles.vtt",buildVTT(),"text/vtt");
  setTimeout(()=>{
    downloadFile("xiaoya_subtitles.srt",buildSRT(),"text/plain");
    toast("📝 已导出 WebVTT + SRT 字幕");
  }, 400);
});

/* ---------- 人设回复引擎 ---------- */
const R = {
  jealous:[
    "哼，你提别的女生干什么……你眼里到底还有没有我啊？",
    "什么别的女生，我才不在乎呢（其实超在意，你最好解释清楚）。",
    "你该不会背着我和谁聊得正开心吧？说！她是谁！",
    "哼，外面的人再好也不准看，看我就好，听到没有。"
  ],
  love:[
    "……笨蛋，突然说这种话干嘛。不过……勉强开心一下好了。",
    "哼，现在才想起来表白？不过……我也稍微，有一点点想你啦。",
    "你、你认真点啊！谁、谁要你喜欢了（小声：谢谢）。"
  ],
  greet:[
    "哼，终于想起我啦？等你半天了都。",
    "来啦？人家还以为你把我忘在角落里了呢。",
    "算你识相，主动来找我。说吧，今天怎么这么乖。"
  ],
  sad:[
    "你刚才去哪儿了嘛……人家等了好久，还以为你不要我了，呜。",
    "你都不理我……我委屈。下次要第一时间找我，知道吗？",
    "等得我都要睡着了，你知不知道我有多想你（才怪）。"
  ],
  tantrum:[
    "你凶我！我不理你了！……除非你哄我。",
    "哼，你就是这样对我的？我生气了，后果很严重！",
    "你再这样我可要闹了啊，真的会闹的！"
  ],
  tsundere:[
    "哼，你才知道问我啊。",
    "才不是想你了呢，别自作多情。",
    "你今天怎么这么笨，连这个都不懂。",
    "想我了就直说嘛，我又不会笑你……大概。",
    "别盯着别人看啦，看我就好。",
    "哼，算是你会说话。勉强给你加一分。",
    "你呀，总是让我操心。不过……算了，谁让我是你女朋友呢。"
  ]
};
const pick = arr => arr[Math.floor(Math.random()*arr.length)];

/* 人设回复规则（可配置化，避免关键词硬编码散落在 reply() 内）
   顺序即优先级：吃醋 > 表白 > 撒娇委屈 > 招呼 > 闹脾气；均未命中则回落傲娇默认。
   每条：type 对应 R.<type> 话术库；emoji/mood/status 命中时写入心情；keywords 为触发词。
   服务端 /api/config 的 persona 字段(数组)可整体覆盖本默认——不下发则走默认。 */
const DEFAULT_PERSONA_RULES = [
  { type:"jealous", emoji:"😾", mood:"吃醋", status:"清冷温柔 · 当前心情：酸酸的 🍋",
    keywords:["别的女生","其他女生","前女友","女朋友","约会","帅哥","聊骚","不理我","出去玩"] },
  { type:"love",   emoji:"😳", mood:"害羞", status:"嘴硬心软 · 其实很开心",
    keywords:["喜欢你","爱你","爱死","想你","漂亮","可爱","宝贝","亲"] },
  { type:"greet",  emoji:null, mood:null, status:null,
    keywords:["在吗","你好","hi","在不在","哈喽","喂"] },
  { type:"tantrum", emoji:"😤", mood:"闹脾气", status:"傲娇炸毛中 · 需要被哄",
    keywords:["凶","烦","滚","闭嘴","讨厌"] },
];
let PERSONA_RULES = DEFAULT_PERSONA_RULES;   // 运行期可被服务端配置覆盖

function reply(userText){
  for(const rule of PERSONA_RULES){
    if(!rule || !Array.isArray(rule.keywords)) continue;
    if(rule.keywords.some(k=>userText.includes(k))){
      const pool = (R && R[rule.type]) || R.tsundere;   // 话术库缺失则回落默认，避免 pick(undefined)
      if(rule.emoji) setMood(rule.emoji, rule.mood, rule.status);
      return pick(pool);
    }
  }
  setMood("😼","傲娇","清冷温柔 · 嘴硬心软 · 爱吃醋");
  return pick(R.tsundere);
}

/* 等待过久 -> 委屈开场 */
function maybeSad(){
  const gap = Date.now()-lastActive;
  if(gap>45000){ // 超过45秒算"等久了"
    setMood("🥺","委屈","等你等得有点委屈了…");
    return pick(R.sad);
  }
  return null;
}

/* ---------- 发送流程 ---------- */
function send(){
  const text=inputEl.value.trim();
  if(!text) return;
  addMsg("user",text);
  inputEl.value="";
  lastActive=Date.now();
  // 同步进模块化 SubtitleTrack（设计包 M2 REQ-CT-01：用户台词也入库，供创作面板双侧导出；库内已含 SafetyFilter 末端安检）
  if(window.Xiaoya && window.Xiaoya.subtitle){ try{ window.Xiaoya.subtitle.push({speaker:"user",text}); }catch(e){} }
  fsPush("user", text);   // 全屏模式：左侧无框渐隐字幕（用户侧）

  const sad=messagesEl.querySelectorAll(".msg").length>1 ? maybeSad() : null;
  // 打字中…
  const typing=document.createElement("div");
  typing.className="msg";
  typing.innerHTML='<img class="av" src="xiaoya.png" alt=""/><div><div class="name">小雅</div><div class="typing"><span></span><span></span><span></span></div></div>';
  messagesEl.appendChild(typing); scrollBottom();

  setTimeout(async ()=>{
    typing.remove();
    let content = await fetchLLM(text);          // 优先真实大模型
    if(!content) content = sad ? sad+" "+reply(text) : reply(text);  // 回退本地引擎
    if(content) { addMsg("bot",content); digitalHumanSpeak(content); }
    lastActive=Date.now();
  }, 700+Math.random()*700);
}

$("#sendBtn").addEventListener("click",send);
inputEl.addEventListener("keydown",e=>{if(e.key==="Enter")send();});

/* ---------- 语音播报开关 ---------- */
$("#ttsToggle").addEventListener("click",function(){
  ttsOn=!ttsOn; this.classList.toggle("on",ttsOn);
  toast(ttsOn?"🔊 小雅会开口说话啦":"🔇 已静音");
});

/* ---------- 背景音乐：御姐进行曲 ---------- */
const bgm=$("#bgm");
let bgmOn=false;
$("#bgmToggle").addEventListener("click",function(){
  if(bgmOn){ bgm.pause(); bgmOn=false; this.classList.remove("on"); toast("🎵 音乐已暂停"); }
  else{
    bgm.play().then(()=>{bgmOn=true;this.classList.add("on");toast("🎵 御姐进行曲 播放中");})
      .catch(()=>toast("⚠️ 请把 yujie-march.mp3 放到本文件夹（版权音乐需自备）"));
  }
});

/* ---------- 语音输入（STT，浏览器原生） ---------- */
const voiceBtn=$("#voiceBtn");
const fsMic=$("#fsMic");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec=null, listening=false;
function setListening(on){
  listening=on;
  voiceBtn.classList.toggle("listening",on);
  if(fsMic) fsMic.classList.toggle("listening",on);
}
if(SR){
  rec=new SR(); rec.lang="zh-CN"; rec.interimResults=false; rec.continuous=false;
  rec.onresult=e=>{ const r=e.results[0][0].transcript; inputEl.value=r; send(); };
  rec.onend=()=>setListening(false);
  rec.onerror=()=>{setListening(false);toast("语音识别不可用，换个浏览器试试～");};
}
function toggleVoice(){
  if(!SR){ toast("当前浏览器不支持语音输入（建议 Chrome）"); return; }
  if(!listening){ try{rec.start();setListening(true);toast("🎙️ 在听…说完自动发送");if(fsHint)fsHint.classList.remove("show");}catch(_){} }
  else { rec.stop(); setListening(false); }
}
voiceBtn.addEventListener("click",toggleVoice);
if(fsMic) fsMic.addEventListener("click",toggleVoice);
// 全屏模式下，点击人像区域也可开始/停止说话（影院式沉浸交互）
if(stageEl) stageEl.addEventListener("click",()=>{ if(document.body.classList.contains("fs-mode")) toggleVoice(); });

/* ---------- 全屏陪伴模式（影院式铺开 + 左侧无框渐隐字幕） ---------- */
const fsSub=$("#fsSub");
const fsHint=$("#fsHint");
const fsToggle=$("#fsToggle");
const fsExit=$("#fsExit");
let _fsLast={who:"",text:"",t:0}, fsOn=false;
function fsPush(who,text){
  if(!fsSub) return;
  text=(text||"").trim(); if(!text) return;
  const now=Date.now();
  if(who===_fsLast.who && text===_fsLast.text && now-_fsLast.t<1000) return; // 防重复（startCap 多次调用）
  _fsLast={who,text,t:now};
  const line=document.createElement("div");
  line.className="line "+(who==="user"?"me":"bot");
  line.textContent=(who==="user"?"你："+text:text);
  fsSub.appendChild(line);
  requestAnimationFrame(()=>requestAnimationFrame(()=>line.classList.add("show")));
  if(fsSub.children.length>5){                 // 超出则最旧一行渐隐移除
    const old=fsSub.firstChild; old.classList.remove("show");
    setTimeout(()=>{ if(old.parentNode) old.parentNode.removeChild(old); },600);
  }
}
function fsClear(){ if(fsSub) fsSub.innerHTML=""; }
function setFs(on){
  fsOn=!!on;
  document.body.classList.toggle("fs-mode",fsOn);
  if(fsToggle) fsToggle.classList.toggle("on",fsOn);
  if(fsOn){
    fsClear();
    if(fsHint) fsHint.classList.add("show");
    const el=document.documentElement;
    if(el.requestFullscreen) el.requestFullscreen().catch(()=>{});   // 增强沉浸；失败不影响 CSS 全屏
  }else{
    setListening(false); fsClear();
    if(fsHint) fsHint.classList.remove("show");
    if(document.fullscreenElement && document.exitFullscreen){
      const ep=document.exitFullscreen();   // 旧浏览器 exitFullscreen() 不返回 Promise，直接 .catch 会抛 TypeError
      if(ep&&typeof ep.catch==="function") ep.catch(()=>{});
    }
  }
}
if(fsToggle) fsToggle.addEventListener("click",()=>setFs(!fsOn));
if(fsExit) fsExit.addEventListener("click",()=>setFs(false));
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && fsOn) setFs(false); });
document.addEventListener("fullscreenchange",()=>{ if(!document.fullscreenElement && fsOn) setFs(false); });

/* ---------- 真实数字人视频（可选） ----------
   把 DH_VIDEO 指向你的数字人 mp4（如 "xiaoya_digital.mp4"），
   右侧人像会自动切换为可循环播放的数字人视频，口型由该视频驱动。 */
const DH_VIDEO = "";
const stageVideo=$("#stageVideo");
if(DH_VIDEO){
  stageVideo.src=DH_VIDEO; stageVideo.style.display="block";
  $("#stageImg").style.display="none";
  stageVideo.play().catch(()=>{});
  toast("🎬 已启用数字人视频");
}

/* ---------- 小雅记忆库（localStorage 持久化） ---------- */
const MEM_KEY="xiaoya_memory_v1";
let memory=JSON.parse(localStorage.getItem(MEM_KEY)||"[]");
const saveMemory=()=>localStorage.setItem(MEM_KEY,JSON.stringify(memory.slice(-40)));
const logMemory=(who,text)=>{memory.push({who,text,t:Date.now()});saveMemory();};
const escapeHtml=s=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

const memModal=$("#memModal");
function openMem(){
  const list=$("#memList"); list.innerHTML="";
  if(!memory.length){ list.innerHTML='<div class="mem-item">还没有回忆呢，去和小雅聊聊天吧～</div>'; }
  else memory.slice().reverse().forEach(m=>{
    const d=document.createElement("div");
    d.className="mem-item"+(m.who==="user"?" me":"");
    d.innerHTML='<b>'+(m.who==="user"?"你":"小雅")+'：</b> '+escapeHtml(m.text);
    list.appendChild(d);
  });
  memModal.classList.add("show");
}
$("#memClose").addEventListener("click",()=>memModal.classList.remove("show"));
$("#memClear").addEventListener("click",()=>{memory=[];saveMemory();openMem();toast("🧹 记忆已清空");});
memModal.addEventListener("click",e=>{if(e.target===memModal)memModal.classList.remove("show");});

/* ---------- 设置面板 ---------- */
const THEMES={
  night :{name:"暗夜青",cyan:"#3fe0ff",purple:"#a974ff",pink:"#ff5d8f"},
  violet:{name:"紫电", cyan:"#9b6bff",purple:"#c46bff",pink:"#ff7ad9"},
  sakura:{name:"樱粉", cyan:"#ff8fc4",purple:"#ff6fa5",pink:"#ff3d7f"},
  matrix:{name:"赛博绿",cyan:"#39ff9e",purple:"#27d3a2",pink:"#7dff5d"}
};
const SET_KEY="xiaoya_settings_v1";
let settings=Object.assign({theme:"night",rate:1.02,pitch:1.15,tts:true,edgeVoice:"",
  dhEnabled:true,dhProvider:"local",dhKey:"",dhAvatar:"",dhVoice:"",
  llmEnabled:false,llmEndpoint:"https://api.deepseek.com/v1/chat/completions",
  llmKey:"",llmModel:"deepseek-chat",
  llmSystem:"你是赛博女友小雅。傲娇、敏感、爱吃醋；说话口语化、带点小脾气；等用户久了会委屈；偶尔闹情绪但很快被哄好。用简短可爱的中文回复，不要长篇大论。"},
  JSON.parse(localStorage.getItem(SET_KEY)||"{}"));
ttsRate=settings.rate; ttsPitch=settings.pitch; ttsOn=settings.tts;
$("#ttsToggle").classList.toggle("on",ttsOn);

function saveSettings(){ localStorage.setItem(SET_KEY,JSON.stringify(settings)); }
function applyTheme(key){
  const t=THEMES[key]; if(!t) return;
  const r=document.documentElement.style;
  r.setProperty("--cyan",t.cyan); r.setProperty("--purple",t.purple); r.setProperty("--pink",t.pink);
  settings.theme=key; saveSettings();
  document.querySelectorAll(".swatch").forEach(s=>s.classList.toggle("active",s.dataset.k===key));
}
const swEl=$("#swatches");
Object.entries(THEMES).forEach(([k,t])=>{
  const s=document.createElement("div");
  s.className="swatch"; s.dataset.k=k; s.title=t.name;
  s.style.background=`linear-gradient(135deg,${t.cyan},${t.purple})`;
  s.addEventListener("click",()=>applyTheme(k));
  swEl.appendChild(s);
});
applyTheme(settings.theme);

const rateEl=$("#rate"), pitchEl=$("#pitch"), rateVal=$("#rateVal"), pitchVal=$("#pitchVal");
rateEl.value=settings.rate; pitchEl.value=settings.pitch;
rateVal.textContent=(+settings.rate).toFixed(2); pitchVal.textContent=(+settings.pitch).toFixed(2);
rateEl.addEventListener("input",()=>{ttsRate=+rateEl.value;settings.rate=ttsRate;rateVal.textContent=ttsRate.toFixed(2);saveSettings();});
pitchEl.addEventListener("input",()=>{ttsPitch=+pitchEl.value;settings.pitch=ttsPitch;pitchVal.textContent=ttsPitch.toFixed(2);saveSettings();});

const ttsChk=$("#ttsChk"); ttsChk.checked=settings.tts;
ttsChk.addEventListener("change",()=>{ttsOn=ttsChk.checked;settings.tts=ttsOn;saveSettings();
  $("#ttsToggle").classList.toggle("on",ttsOn); toast(ttsOn?"🔊 语音已开":"🔇 已静音");});

// Edge-TTS 音色选择器（独立于此项目的远程数字人 Voice ID：dhVoice）
const edgeVoiceSel=$("#edgeVoice");
if(edgeVoiceSel && window.XiaoyaVoice && window.XiaoyaVoice.AVAILABLE_VOICES){
  window.XiaoyaVoice.AVAILABLE_VOICES.forEach(v=>{
    const o=document.createElement("option"); o.value=v.id; o.textContent=v.label; edgeVoiceSel.appendChild(o);
  });
  edgeVoiceSel.value=settings.edgeVoice||"";
  edgeVoiceSel.addEventListener("change",()=>{
    settings.edgeVoice=edgeVoiceSel.value||"";
    saveSettings(); pushRemoteConfig();
    if(_xiaoyaVoice) _xiaoyaVoice.preferredVoice=settings.edgeVoice||null;
    toast(settings.edgeVoice?("🗣️ 已切换 Edge-TTS 音色："+edgeVoiceSel.options[edgeVoiceSel.selectedIndex].textContent):"已恢复按情绪自动选音色");
  });
}

$("#bgmFile").addEventListener("change",e=>{
  const f=e.target.files[0]; if(!f) return;
  bgm.src=URL.createObjectURL(f); $("#bgmName").textContent="已载入："+f.name+"（点右上角音符播放）";
  toast("🎵 音乐已载入，点音符播放");
});

/* ---------- 数字人接入（真实 API 脚手架） ---------- */
const dh={enabled:!!settings.dhEnabled,provider:settings.dhProvider||"local",
  key:settings.dhKey||"",avatar:settings.dhAvatar||"",voice:settings.dhVoice||""};
const dhActive=()=>dh.enabled && dh.key && dh.avatar;

/* 大模型配置：从设置加载到运行时 LLM 对象 */
LLM.enabled=!!settings.llmEnabled;
LLM.endpoint=settings.llmEndpoint||LLM.endpoint;
LLM.apiKey=settings.llmKey||"";
LLM.model=settings.llmModel||LLM.model;
LLM.system=settings.llmSystem||LLM.system;

// HeyGen：文本 -> 生成口型视频 -> 轮询状态 -> 取视频地址
// 走本地代理 /api/heygen（server.py 转发并注入 Key，规避 CORS）；直连模式 fallback 仍可用
function heygenBase(){
  // 经本地服务器/代理访问时走 /api/heygen（密钥经服务端转发，规避 CORS）
  // 若直接双击打开 file://，则直连 HeyGen（使用面板里填写的 key）
  if(location.protocol==="file:") return "https://api.heygen.com";
  return "/api/heygen";
}
async function heygenGenerate(text){
  const body=JSON.stringify({
    type:"avatar",
    avatar_id:dh.avatar,
    script:text,
    voice_id:dh.voice,
    aspect_ratio:"9:16",
    background:{value:"#060810"},
    output_format:"mp4"
  });
  const tryBase=async(base)=>{
    const headers={"Content-Type":"application/json"};
    if(dh.key) headers["x-api-key"]=dh.key;          // 面板里填的 key 随请求发往代理/直连
    const res=await fetch(base+"/v3/videos",{method:"POST",headers,body});
    const j=await res.json().catch(()=>({}));
    if(j.error||!j.data?.video_id) throw new Error(j.error?.message||("HTTP "+res.status));
    return j.data.video_id;
  };
  const base=heygenBase();
  return await tryBase(base);   // 应用始终经本地代理/server 提供，失败直接抛出（不回退直连，避免掩盖真实错误）
}
async function heygenStatus(id){
  const tryBase=async(base)=>{
    const headers={};
    if(dh.key) headers["x-api-key"]=dh.key;
    const res=await fetch(base+"/v3/videos/"+encodeURIComponent(id),{headers});
    const j=await res.json().catch(()=>({data:{}}));
    return j.data||{};
  };
  const base=heygenBase();
  return await tryBase(base);
}

// 腾讯智影 / 数智人：走本地代理（服务端 TC3 签名），前端只传文本与 Avatar/Voice ID
async function zhiyingGenerate(text){
  const res=await fetch("/api/zhiying/generate",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({text, avatar:dh.avatar, voice:dh.voice})
  });
  const j=await res.json();
  if(j.error||!j.data?.video_id) throw new Error(j.error?.message||"生成失败");
  return j.data.video_id;
}
async function zhiyingStatus(id){
  const res=await fetch("/api/zhiying/status?video_id="+encodeURIComponent(id),{headers:{}});
  return (await res.json()).data||{};
}

// 本地动画数字人：纯前端 SVG 头像 + 浏览器免费 TTS（Web Speech API），离线可用、不依赖任何海外 API。
// 专为本机连不上 HeyGen/智影等海外服务时的"网络稳定且免费"方案：口型随语音实时开合 + 随机眨眼。
const stageAvatar=$("#stageAvatar");
const avMouthG=document.getElementById("avMouthG");
const avEyes=document.getElementById("avEyes");
function setMouth(k){ // k: 0.14(闭) -> 1(张)，绕嘴中心 (120,186) 缩放
  if(avMouthG) avMouthG.setAttribute("transform","translate(120,186) scale(1,"+k+") translate(-120,-186)");
}
function doBlink(){
  if(!avEyes) return;
  avEyes.setAttribute("transform","translate(120,148) scale(1,0.1) translate(-120,-148)");
  setTimeout(()=>avEyes.setAttribute("transform","translate(0,0)"),140);
}
function showAvatar(){
  $("#stageImg").style.display="none"; stageVideo.style.display="none"; stageAvatar.style.display="flex";
}
function hideAvatar(){
  stageAvatar.style.display="none"; $("#stageImg").style.display=""; stageVideo.style.display="none";
}
async function localAvatarSpeak(text){
  if(_activeSpeech){ _activeSpeech.abort(); _activeSpeech=null; }  // 抢占上一段动画/语音
  const my = ++_speechToken;
  showAvatar();
  let stopped=false, started=false, flapTimer=null, blinkTimer=null, safety=null;
  const flap=()=>{ if(stopped) return; setMouth(0.14+Math.random()*0.86); flapTimer=setTimeout(flap,90+Math.random()*170); };
  const blink=()=>{ if(stopped) return; doBlink(); blinkTimer=setTimeout(blink,2200+Math.random()*2800); };
  const startAnim=()=>{ if(started||stopped) return; started=true; stageEl.classList.add("speaking"); flap(); blink(); };
  // 被新播报抢占时调用：仅停动画/语音，不 endCap（字幕由 digitalHumanSpeak.startCap 统一管理）
  const stopOnly=()=>{
    if(stopped) return; stopped=true;
    if(flapTimer) clearTimeout(flapTimer);
    if(blinkTimer) clearTimeout(blinkTimer);
    if(safety) clearTimeout(safety);
    setMouth(0.14);
    stageEl.classList.remove("speaking");
    hideAvatar(); hideAIBadge();
    if(_activeSpeech && _activeSpeech.token===my) _activeSpeech=null;
  };
  const finish=()=>{
    if(stopped) return; stopped=true;
    if(flapTimer) clearTimeout(flapTimer);
    if(blinkTimer) clearTimeout(blinkTimer);
    if(safety) clearTimeout(safety);
    setMouth(0.14);
    stageEl.classList.remove("speaking");
    endCap(); hideAvatar(); hideAIBadge();
    if(_activeSpeech && _activeSpeech.token===my) _activeSpeech=null;
  };
  _activeSpeech = { token: my, abort: stopOnly };
  if(ttsOn && 'speechSynthesis' in window){
    const u=new SpeechSynthesisUtterance(text);
    u.lang="zh-CN"; u.rate=ttsRate; u.pitch=ttsPitch;
    const ev=pickEdgeVoice();                       // 优先用用户指定的 Edge-TTS 音色（离线命中本地 Online 语音）
    if(ev) u.voice=ev; else if(voiceZh) u.voice=voiceZh;
    u.onstart=()=>{ if(my!==_speechToken) return; startAnim(); };
    u.onboundary=()=>{ if(my!==_speechToken) return; setMouth(1); };
    u.onend=()=>{ if(my!==_speechToken) return; finish(); };
    u.onerror=()=>{ if(my!==_speechToken) return; finish(); };
    speechSynthesis.cancel(); speechSynthesis.speak(u);
    startAnim();                                                                   // 立即开嘴：避免浏览器缺中文语音时 onstart 不触发导致静止/卡住
    safety=setTimeout(finish, Math.max(4000,text.length*300)+1500);               // 兜底：TTS 异常不结束也强制复位
  }else{
    startAnim();
    safety=setTimeout(finish, Math.max(1600,text.length*210));
  }
}

// 小雅开口：本地动画=免费离线首选；HeyGen/智影失败或没配齐时自动退回本地动画（始终有可见数字人）
async function digitalHumanSpeak(text){
  if(_activeSpeech){ _activeSpeech.abort(); _activeSpeech=null; }  // 抢占可能残留的本地动画/语音
  startCap(text);
  renderAIBadge(); // 数字人输出即挂"由 AI 生成"水印（REQ-COMP-01）
  if(!dh.enabled){ speak(text); return; }                       // 数字人总开关关 -> 纯音频
  if(dh.provider==="local"){ localAvatarSpeak(text); return; }
  if(!dhActive()){
    toast("⚠️ 数字人未配齐，已回退本地动画数字人（免费/离线）");
    localAvatarSpeak(text); return;
  }
  try{
    const gen  = dh.provider==="zhiying" ? zhiyingGenerate : heygenGenerate;
    const stat = dh.provider==="zhiying" ? zhiyingStatus  : heygenStatus;
    const id=await gen(text);
    let data={};
    for(let i=0;i<60;i++){            // 最多等 ~3 分钟
      await new Promise(r=>setTimeout(r,3000));
      data=await stat(id);
      if(data.video_url) break;
      if(data.status==="failed") throw new Error("生成失败");
    }
    if(data.video_url){
      $("#stageImg").style.display="none";
      stageVideo.loop=false; stageVideo.controls=false; stageVideo.muted=false;
      stageVideo.src=data.video_url; stageVideo.style.display="block";
      try{ await stageVideo.play(); }
      catch(e){
        stageVideo.muted=true; await stageVideo.play().catch(()=>{});   // 声音被拦截则静音保动画
        stageVideo.controls=true;
        toast("🔇 浏览器限制了声音，点视频右下角可取消静音");
      }
      stageEl.classList.add("speaking");
      endCap();
      stageVideo.onended=()=>{stageEl.classList.remove("speaking");hideAIBadge();};
    }else{ localAvatarSpeak(text); }
  }catch(e){
    console.warn("数字人失败，回退本地动画数字人：",e);
    const msg=(e&&e.message)?e.message:String(e);
    if(/Failed to fetch|NetworkError|timeout|ECONN|10060|network|连接/i.test(msg))
      toast("⚠️ 远程数字人生成失败（网络不可达/代理异常），已回退本地动画数字人（免费/离线）");
    else
      toast("⚠️ 远程数字人生成失败（"+msg+"），已回退本地动画数字人");
    localAvatarSpeak(text);
  }
}

/* ---------- 数字人设置联动 ---------- */
const dhChk=$("#dhChk"),dhProv=$("#dhProvider"),dhKey=$("#dhKey"),dhAvatar=$("#dhAvatar"),dhVoice=$("#dhVoice");
dhChk.checked=dh.enabled; dhProv.value=dh.provider; dhKey.value=dh.key; dhAvatar.value=dh.avatar; dhVoice.value=dh.voice;
function syncDH(){
  dh.enabled=dhChk.checked; dh.provider=dhProv.value;
  dh.key=dhKey.value.trim(); dh.avatar=dhAvatar.value.trim(); dh.voice=dhVoice.value.trim();
  Object.assign(settings,{dhEnabled:dh.enabled,dhProvider:dh.provider,dhKey:dh.key,dhAvatar:dh.avatar,dhVoice:dh.voice});
  saveSettings();
  pushRemoteConfig();
  updateDhKeyLink();
  toast(dhActive()?"🎬 数字人已启用（文本驱动口型）":"数字人配置已保存");
}
[dhChk,dhProv].forEach(el=>el.addEventListener("change",syncDH));
[dhKey,dhAvatar,dhVoice].forEach(el=>el.addEventListener("input",syncDH));

/* 数字人各服务商「获取 API Key」官方超链接（随服务商切换动态更新） */
const DH_KEY_URLS = {
  heygen:  { url:"https://app.heygen.com/settings/api", txt:"HeyGen API Key 获取页", note:"" },
  zhiying: { url:"https://console.cloud.tencent.com/cam/capi", txt:"腾讯云 API 密钥（SecretId/SecretKey）", note:"密钥放服务端 keys.json，前端只填 Avatar/Voice ID" },
  guiji:   { url:"https://cloud.siliconflow.cn/account/ak", txt:"硅基流动 API Key", note:"如走硅基数字人" },
  local:   null
};
function updateDhKeyLink(){
  const p = dhProv.value;
  const a = document.getElementById("dhKeyLink");
  const note = document.getElementById("dhKeyNote");
  const info = DH_KEY_URLS[p];
  if(!info){ // local：无需 Key
    a.style.display = "none";
    note.textContent = (p==="local") ? "🌟 本地动画数字人（免费/离线），无需 API Key" : "";
    return;
  }
  a.style.display = "inline";
  a.href = info.url;
  a.textContent = "🔑 " + info.txt + " ↗";
  note.textContent = info.note ? "· " + info.note : "";
}
updateDhKeyLink(); // 初始化：按当前服务商显示对应链接

/* ---------- 大模型设置联动 ---------- */
const llmChk=$("#llmChk"),llmEp=$("#llmEndpoint"),llmKey=$("#llmKey"),llmModel=$("#llmModel"),llmSys=$("#llmSystem");
llmChk.checked=LLM.enabled; llmEp.value=LLM.endpoint; llmKey.value=LLM.apiKey; llmModel.value=LLM.model; llmSys.value=LLM.system;
function syncLLM(){
  LLM.enabled=llmChk.checked;
  LLM.endpoint=llmEp.value.trim()||"https://api.deepseek.com/v1/chat/completions";
  LLM.apiKey=llmKey.value.trim();
  LLM.model=llmModel.value.trim()||"deepseek-chat";
  LLM.system=llmSys.value.trim()||LLM.system;
  Object.assign(settings,{llmEnabled:LLM.enabled,llmEndpoint:LLM.endpoint,llmKey:LLM.apiKey,llmModel:LLM.model,llmSystem:LLM.system});
  saveSettings();
  pushRemoteConfig();
  toast(LLM.enabled&&LLM.apiKey?"🤖 大模型已启用（优先真实回复）":"大模型配置已保存");
}
llmChk.addEventListener("change",syncLLM);
[llmEp,llmKey,llmModel,llmSys].forEach(el=>el.addEventListener("input",syncLLM));

/* ---------- API 配置持久化（服务端文件兜底，跨端口/重启保留） ---------- */
/* localStorage 按 http://127.0.0.1:端口 隔离，且可能被清空；
   故除写 localStorage 外，再把 API 配置落地到服务端 xiaoya_config.json，
   启动时优先用服务端配置回填，保证刷新/重启/换端口都不丢。 */
const CFG_KEYS=["dhEnabled","dhProvider","dhKey","dhAvatar","dhVoice","edgeVoice",
  "llmEnabled","llmEndpoint","llmKey","llmModel","llmSystem"];
function pushRemoteConfig(){
  if(location.protocol==="file:") return;            // 直开文件无服务端，退回 localStorage
  const payload={};
  CFG_KEYS.forEach(k=>payload[k]=settings[k]);
  fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)}).catch(()=>{});
}
async function loadRemoteConfig(){
  if(location.protocol==="file:") return;            // 直开文件：仅用 localStorage
  try{
    const r=await fetch("/api/config",{cache:"no-store"});
    if(!r.ok) return;
    const cfg=await r.json();
    if(!cfg||typeof cfg!=="object") return;
    CFG_KEYS.forEach(k=>{
      const rv=cfg[k];
      if(rv!==undefined && rv!=="") settings[k]=rv;   // 服务端非空值优先（跨端口一致）
    });
    // 人设规则：服务端显式下发 persona 数组则整体覆盖默认（不下发保留 DEFAULT_PERSONA_RULES，且不回写服务端）
    if(Array.isArray(cfg.persona) && cfg.persona.length){
      const rules = cfg.persona.filter(r=>r && typeof r.type==="string" && Array.isArray(r.keywords) && r.keywords.length);
      if(rules.length) PERSONA_RULES = rules;
    }
    // 同步到运行时对象 dh / LLM
    dh.enabled=!!settings.dhEnabled;
    dh.provider=settings.dhProvider||dh.provider;   // 仅当服务端显式下发非空 provider 才覆盖；否则保留本地/默认，避免静默翻成 heygen
    dh.key=settings.dhKey||""; dh.avatar=settings.dhAvatar||""; dh.voice=settings.dhVoice||"";
    LLM.enabled=!!settings.llmEnabled;
    LLM.endpoint=settings.llmEndpoint||LLM.endpoint;
    LLM.apiKey=settings.llmKey||"";
    LLM.model=settings.llmModel||LLM.model;
    LLM.system=settings.llmSystem||LLM.system;
    // 回填 UI 输入框
    dhChk.checked=dh.enabled; dhProv.value=dh.provider; dhKey.value=dh.key;
    dhAvatar.value=dh.avatar; dhVoice.value=dh.voice;
    if(edgeVoiceSel) edgeVoiceSel.value=settings.edgeVoice||"";   // 回填服务端下发的 Edge-TTS 音色
    llmChk.checked=LLM.enabled; llmEp.value=LLM.endpoint; llmKey.value=LLM.apiKey;
    llmModel.value=LLM.model; llmSys.value=LLM.system;
    updateDhKeyLink();                                // 远程配置也可能改变服务商，刷新 Key 链接
    saveSettings();                                   // 同时更新 localStorage 备份
    pushRemoteConfig();                               // 把本地独有值也同步回服务端
  }catch(e){ /* 服务端不可达，静默退回 localStorage */ }
}
loadRemoteConfig();                                   // 启动即拉取服务端配置

const setModal=$("#setModal");
$("#setClose").addEventListener("click",()=>setModal.classList.remove("show"));
setModal.addEventListener("click",e=>{if(e.target===setModal)setModal.classList.remove("show");});

/* ---------- 左侧导航切换 ---------- */
document.querySelectorAll(".app-nav .item").forEach(it=>{
  it.addEventListener("click",()=>{
    document.querySelectorAll(".app-nav .item").forEach(x=>x.classList.remove("active"));
    it.classList.add("active");
    const map={chat:"在线 · 傲娇模式已开启",love:"恋爱中 · 心跳 +20%",mem:"记忆库 · 我们的聊天记录",set:"设置 · 皮肤 / 语音 / 音乐",create:"创作间 · 录屏 / 片段 / 场景 / 主题"};
    $("#status").textContent=map[it.dataset.tab]||"在线";
    if(it.dataset.tab==="mem") openMem();
    if(it.dataset.tab==="set") setModal.classList.add("show");
    if(it.dataset.tab==="create") openCreator();
  });
});

/* 设计包模块化内核桥接：实例化 VoiceEngine / DigitalHuman（window 全局来自上方模块化脚本），
   供控制台调试与后续深度接入；AI 水印统一走 renderAIBadge。运行时播报仍由内联 speak/digitalHumanSpeak 驱动，
   二者全局名不冲突。多供应商切换以 UI 的 dh.provider 为真源（syncDH 已联动）。 */
const _xiaoyaVoice = (window.XiaoyaVoice) ? new window.XiaoyaVoice.VoiceEngine({
  mode: (typeof LLM!=="undefined" && LLM.enabled) ? "enhanced" : "local",
  preferredVoice: settings.edgeVoice || null,   // 用户手动指定的 Edge-TTS 音色（增强模式生效）
  hooks: { onAIBadge: renderAIBadge }
}) : null;
const _xiaoyaDH = (window.XiaoyaDH) ? new window.XiaoyaDH.DigitalHuman({
  providers: ["zhiying","heygen","guiji","local"],
  current: (typeof dh!=="undefined" && dh.provider) || "local",
  aiBadgeHook: renderAIBadge
}) : null;
/* 设计包 M2 创作工作流内核桥接：实例化 SubtitleTrack/ClipBest/StudioWorkflow/Recorder/MemoryStore（window 全局来自上方模块化脚本）。
   运行时创作 UI（录屏/片段/场景/主题/记忆）由下方内联逻辑驱动；此处暴露内核供调试与后续深度接入。 */

// 创作面板内置场景（REQ-FUN-01：unlockLevel 门禁；relationLevel 由下方 _relationLevel 控制）
const _CREATOR_SCENES = {
  daily : { id:"daily",  name:"日常卧室", unlockLevel:0, desc:"默认温馨日常场景" },
  date  : { id:"date",   name:"约会影院", unlockLevel:1, desc:"一起看电影的甜蜜场景" },
  travel: { id:"travel", name:"海边旅行", unlockLevel:3, desc:"夏日海边的放松时刻" },
  secret: { id:"secret", name:"私密晚安", unlockLevel:5, desc:"仅极高亲密度解锁（演示门禁）" }
};
// 创作面板内置主题包（REQ-FUN-02：仅白名单字段；avatarFilter 仅 CSS filter 白名单）
const _CREATOR_THEMES = {
  neon  : { id:"neon",   name:"赛博霓虹", colors:{bg:"#0a0e1c",panel:"rgba(20,26,48,.6)",accent:"#3fe0ff",text:"#e8edff",xiaoyaTint:"#ff5d8f"}, avatarFilter:"saturate(1.2) contrast(1.05)" },
  sakura: { id:"sakura", name:"樱粉柔光", colors:{bg:"#1a0e16",panel:"rgba(48,20,38,.6)",accent:"#ff8fc4",text:"#ffe8f2",xiaoyaTint:"#ff3d7f"}, avatarFilter:"brightness(1.05) sepia(.1)" },
  noir  : { id:"noir",   name:"暗夜胶片", colors:{bg:"#050608",panel:"rgba(12,14,20,.7)",accent:"#9aa6c8",text:"#e8edff",xiaoyaTint:"#a974ff"}, avatarFilter:"grayscale(.3) contrast(1.1)" }
};
let _relationLevel = 3; // 演示用亲密度等级（travel 解锁，secret 仍锁）

// 应用主题包：映射白名单 colors 到 CSS 变量 + 套用 avatarFilter；与设置面板 applyTheme 互补但不冲突
function applyStudioTheme(pkg){
  const r = document.documentElement.style;
  if(!pkg){ // 复位：移除创作主题覆盖，回退 :root 默认皮肤
    ["--bg","--bg2","--panel","--txt"].forEach(k=>r.removeProperty(k));
    document.querySelectorAll(".stage img, .stage video, .stage .avatar").forEach(el=>{ el.style.filter=""; });
    return;
  }
  const c = pkg.colors || {};
  if(c.bg)        { r.setProperty("--bg",c.bg);  r.setProperty("--bg2",c.bg); }
  if(c.panel)       r.setProperty("--panel",c.panel);
  if(c.accent)    { r.setProperty("--cyan",c.accent); r.setProperty("--purple",c.accent); }
  if(c.xiaoyaTint)  r.setProperty("--pink",c.xiaoyaTint);
  if(c.text)        r.setProperty("--txt",c.text);
  const f = pkg.avatarFilter ? String(pkg.avatarFilter) : "";
  document.querySelectorAll(".stage img, .stage video, .stage .avatar").forEach(el=>{ el.style.filter = f; });
}

// 模块化 Recorder 桥接（REQ-CT-02）：停止即本地下载 webm（D1 零上传；REQ-COMP-01 水印随屏捕获）
const _xiaoyaRecorder = (window.XiaoyaRecorder) ? new window.XiaoyaRecorder.Recorder({
  hooks: {
    onStart: ()=>{ if(typeof toast==="function") toast("🔴 录制中…（屏幕已含 AI 水印）"); },
    onStop: (blob)=>{
      if(blob){ downloadFile("xiaoya_clip_"+Date.now()+".webm", blob, "video/webm"); if(typeof toast==="function") toast("💾 录制完成，已下载 webm"); }
      else if(typeof toast==="function") toast("⚠️ 未录到内容");
    }
  }
}) : null;

// 模块化 MemoryStore 桥接（REQ-FUN-03）：以运行时 localStorage 记忆库为真相源，暴露 list/update/remove 供创作面板
function _ensureMemId(m){ if(!m._id) m._id = "mem-"+Math.random().toString(36).slice(2,10); return m._id; }
const _memAdapter = {
  put: (rec)=>{
    if(rec && rec.who!==undefined){ _ensureMemId(rec); return; } // 运行时形状直接入库（已在 memory 中）
    if(rec && rec.id){ const ex=memory.find(x=>x._id===rec.id); if(ex){ ex.text=rec.text; ex.who=rec.type||ex.who; saveMemory(); return; }
      memory.push({who:rec.type||"fact", text:rec.text, t:Date.now(), _id:rec.id}); saveMemory(); return; }
  },
  get: (id)=> memory.find(x=>x._id===id) || null,
  getAll: ()=> memory.map(m=>{ const id=_ensureMemId(m); return {id, type:m.who, topic:"对话", text:m.text, createdAt:new Date(m.t||Date.now()).toISOString(), importance:0.5}; }),
  delete: (id)=>{ const i=memory.findIndex(x=>x._id===id); if(i>=0){ memory.splice(i,1); saveMemory(); } }
};
const _xiaoyaMemory = (window.MemoryStore) ? new window.MemoryStore.MemoryStore(_memAdapter, { maxMemory: 500 }) : null;

// 模块化 SubtitleTrack / ClipBest / StudioWorkflow
const _xiaoyaSubtitle = (window.XiaoyaCaptions) ? new window.XiaoyaCaptions.SubtitleTrack({ safety: (window.SafetyFilter||null) }) : null;
const _xiaoyaClip = (window.XiaoyaClip) ? new window.XiaoyaClip.ClipBest({}) : null;
// 创作偏好持久化到 settings（跨刷新保留）
const _studioConfig = { save:(patch)=>{ if(patch && patch.studio){ const s=patch.studio; if(s.defaultScene!==undefined) settings.studioScene=s.defaultScene; if(s.theme!==undefined) settings.studioTheme=s.theme; saveSettings(); pushRemoteConfig(); } } };
const _xiaoyaStudio = (window.XiaoyaStudio) ? new window.XiaoyaStudio.StudioWorkflow({
  subtitle: _xiaoyaSubtitle, clipper: _xiaoyaClip, scenes: _CREATOR_SCENES,
  safety: (window.SafetyFilter||null), config: _studioConfig,
  hooks: {
    onApplyTheme: (pkg)=>{ applyStudioTheme(pkg); },
    onDownload: (blob,name)=>{ if(blob) downloadFile(name||"artifact", blob, "application/octet-stream"); },
    onToast: (m)=>{ if(typeof toast==="function") toast(m); }
  }
}) : null;
window.Xiaoya = { voice: _xiaoyaVoice, digitalHuman: _xiaoyaDH, subtitle: _xiaoyaSubtitle, clip: _xiaoyaClip, studio: _xiaoyaStudio, recorder: _xiaoyaRecorder, memory: _xiaoyaMemory, renderAIBadge };
console.log("[Xiaoya] 模块化内核已桥接：", Object.keys(window.Xiaoya));

/* ---------- 创作面板（设计包 M2 接线） ---------- */
const createModal=$("#createModal");
$("#createClose").addEventListener("click",()=>createModal.classList.remove("show"));
createModal.addEventListener("click",e=>{if(e.target===createModal)createModal.classList.remove("show");});

function openCreator(){
  $("#relLevel").textContent=_relationLevel;
  renderScenes(); renderThemes(); renderMem();
  createModal.classList.add("show");
}

/* ① 录制（REQ-CT-02）：模块化 Recorder 桥接，停止即本地下载 webm */
let _recOn=false;
$("#recToggle").addEventListener("click",async ()=>{
  const rec=window.Xiaoya && window.Xiaoya.recorder;
  if(!rec){ toast("⚠️ 录制内核未加载"); return; }
  if(!_recOn){
    try{ await rec.start(); _recOn=true; $("#recToggle").textContent="■ 停止录制"; $("#recStatus").textContent="录制中"; renderAIBadge(); }
    catch(err){ toast("⚠️ 无法录制："+(err&&err.message||err)+"（需 localhost/HTTPS，file:// 不可用）"); }
  }else{
    await rec.stop(); _recOn=false; $("#recToggle").textContent="● 开始录制"; $("#recStatus").textContent="已保存"; hideAIBadge();
  }
});

/* ② 名场面精选（REQ-CT-03）：取情绪峰值 → 浏览器侧 Canvas 渲染名场面卡 PNG（本地） */
$("#clipGen").addEventListener("click",()=>{
  const st=window.Xiaoya && window.Xiaoya.studio, sub=window.Xiaoya && window.Xiaoya.subtitle, clip=window.Xiaoya && window.Xiaoya.clip;
  if(!st||!sub||!clip){ toast("⚠️ 创作内核未加载"); return; }
  const cues=sub.all()||[];
  if(!cues.length){ toast("还没有字幕，先和小雅聊几句～"); return; }
  const peaks=st.clipBest(3, cues, null); // 运行时未采集情绪日志 → 退化为按时间序取前 3
  if(!peaks.length){ toast("暂无名场面"); return; }
  const card=clip.makeCard(peaks[0]);
  const cv=document.createElement("canvas"); cv.width=720; cv.height=405;
  const cx=cv.getContext("2d");
  const g=cx.createLinearGradient(0,0,720,405); g.addColorStop(0,"#0a0e1c"); g.addColorStop(1,"#1c1140");
  cx.fillStyle=g; cx.fillRect(0,0,720,405);
  cx.fillStyle="#3fe0ff"; cx.font="bold 30px PingFang SC,Microsoft YaHei,sans-serif"; cx.fillText("小雅 · 名场面",40,60);
  cx.fillStyle="#e8edff"; cx.font="24px PingFang SC,Microsoft YaHei,sans-serif"; wrapText(cx, card.text||"", 40, 130, 640, 36);
  cx.fillStyle="#ff5d8f"; cx.font="18px PingFang SC,Microsoft YaHei,sans-serif";
  cx.fillText((card.emotionTag?("情绪："+card.emotionTag+" · "):"")+"时长 "+(card.durationMs/1000).toFixed(1)+"s · 强度 "+card.score.toFixed(2),40,360);
  cv.toBlob(blob=>{ const url=URL.createObjectURL(blob); const prev=$("#clipPreview"); prev.style.display="block"; prev.innerHTML="";
    const img=document.createElement("img"); img.src=url; img.onclick=()=>downloadFile("xiaoya_card_"+Date.now()+".png",blob,"image/png"); prev.appendChild(img);
    const tip=document.createElement("div"); tip.className="hint"; tip.style.padding="8px 12px"; tip.textContent="点击卡片可下载 PNG"; prev.appendChild(tip);
    toast("✨ 已生成名场面卡（点击下载）"); });
});
function wrapText(cx,text,x,y,maxW,lh){
  const chars=Array.from(text||""); let line="", yy=y;
  for(const ch of chars){ const t=line+ch; if(cx.measureText(t).width>maxW){ cx.fillText(line,x,yy); line=ch; yy+=lh; } else line=t; }
  cx.fillText(line,x,yy);
}

/* ③ 场景（REQ-FUN-01）：unlockLevel 门禁，未解锁点击被拦截提示 */
function renderScenes(){
  const box=$("#sceneList"); box.innerHTML=""; const st=window.Xiaoya&&window.Xiaoya.studio;
  Object.values(_CREATOR_SCENES).forEach(sc=>{
    const unlocked = !sc.unlockLevel || _relationLevel>=sc.unlockLevel;
    const b=document.createElement("div");
    b.className="card-btn"+(unlocked?"":" locked")+(st&&st.currentScene&&st.currentScene.id===sc.id?" active":"");
    b.innerHTML='<span class="cb-name">'+escapeHtml(sc.name)+'</span><span class="cb-desc">'+escapeHtml(sc.desc)+'</span>'+(unlocked?"":'<span class="cb-lock">🔒 需亲密度 '+sc.unlockLevel+'</span>');
    if(unlocked) b.addEventListener("click",()=>{ const r=st.applyScene(sc.id,_relationLevel); if(r&&r.ok){ toast("🎭 已切换场景："+sc.name); renderScenes(); } });
    box.appendChild(b);
  });
}

/* ④ 主题（REQ-FUN-02）：白名单校验；导入 JSON 触发 validateTheme */
function renderThemes(){
  const box=$("#themeList"); box.innerHTML=""; const st=window.Xiaoya&&window.Xiaoya.studio;
  Object.values(_CREATOR_THEMES).forEach(th=>{
    const b=document.createElement("div");
    b.className="card-btn"+(st&&st.currentTheme&&st.currentTheme.id===th.id?" active":"");
    b.innerHTML='<span class="cb-name">'+escapeHtml(th.name)+'</span><span class="cb-desc">accent '+escapeHtml(th.colors.accent)+'</span>';
    b.addEventListener("click",()=>{ const r=st.applyTheme(th); if(r&&r.ok){ toast("🎨 已应用主题："+th.name); renderThemes(); } });
    box.appendChild(b);
  });
}
$("#themeReset").addEventListener("click",()=>{ applyStudioTheme(null); applyTheme(settings.theme); toast("🎨 已恢复默认皮肤"); renderThemes(); });
$("#themeFile").addEventListener("change",e=>{
  const f=e.target.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{ try{ const pkg=JSON.parse(rd.result); const st=window.Xiaoya&&window.Xiaoya.studio; const r=st.applyTheme(pkg); if(r&&r.ok){ toast("🎨 主题包已应用"); renderThemes(); } }catch(err){ toast("⚠️ JSON 解析失败："+(err.message||err)); } };
  rd.readAsText(f);
});

/* ⑤ 记忆（REQ-FUN-03 · 模块化 MemoryStore 桥接运行时记忆库） */
function renderMem(){
  const box=$("#createMemList"); box.innerHTML=""; const mem=window.Xiaoya&&window.Xiaoya.memory;
  if(!mem){ box.innerHTML='<div class="mem-item">MemoryStore 未加载</div>'; return; }
  mem.list().then(rows=>{
    if(!rows.length){ box.innerHTML='<div class="mem-item">还没有回忆呢，去和小雅聊聊天吧～</div>'; return; }
    rows.slice().reverse().forEach(r=>{
      const d=document.createElement("div"); d.className="mem-item";
      const who = r.type==="user"?"你":(r.type==="bot"?"小雅":"记忆");
      const txt=document.createElement("span"); txt.className="txt"; txt.textContent=who+"："+r.text;
      const del=document.createElement("button"); del.className="del"; del.textContent="删除";
      del.addEventListener("click",()=>{ mem.remove(r.id).then(()=>{ toast("🧹 已删除一条"); renderMem(); }); });
      d.appendChild(txt); d.appendChild(del); box.appendChild(d);
    });
  });
}
$("#memExport").addEventListener("click",()=>{
  const mem=window.Xiaoya&&window.Xiaoya.memory;
  if(!mem){ toast("⚠️ MemoryStore 未加载"); return; }
  mem.list().then(rows=>{
    if(!rows.length){ toast("还没有记忆可导出"); return; }
    const txt=rows.map(r=>((r.type==="user"?"你":(r.type==="bot"?"小雅":"记忆"))+"："+r.text)).join("\n")+"\n";
    downloadFile("xiaoya_memory_"+Date.now()+".txt",txt,"text/plain"); toast("📄 已导出对话稿");
  });
});

/* 自动欢迎语（首次进入播报）
   合规门禁：先过 ComplianceGate —— 未确认年龄弹确认框；未成年按《办法》拒服（应用不启动）；
   成年放行后才触发欢迎语与出境告知注入。门禁异常时回退直接进入，保证可用性。 */
function bootApp(){
  setTimeout(()=>digitalHumanSpeak("哼，你终于来了，人家等你半天了。"),900);
}
window.addEventListener("load", async ()=>{
  if(window.ComplianceGate){
    try{
      await ComplianceGate.ensureComplianceGate({
        settings: ()=>settings,
        patchSettings: (p)=>{ Object.assign(settings,p); saveSettings(); }
      });
      bootApp();
    }catch(e){ console.warn("合规门禁异常，回退直接进入",e); bootApp(); }
  }else{
    bootApp();
  }
});

/**
 * app.js —— 离线网页版（play/）的编排层。
 *
 * 三个模式（顶部标签切换）：
 *   看示例   —— 播放程序合成的骨架片段（不是真人录制），规则引擎在浏览器里实时运行；
 *   我来练   —— 打开摄像头，MediaPipe 姿态网络出 33 个关键点，同一套规则判定；
 *   练习任务 —— 看示例 + 任务清单，逐项打勾。
 *
 * 规则（计数 / 纠错）、话术、语音、历史、肌肉图全部复用 src/ 里的原模块；
 * 这里只负责界面、回放、右栏「规则引擎面板」和 file:// 兼容的引擎加载（poseEngine.js）。
 */
import { createSquatExercise } from "../src/exercises/squat.js";
import { createJumpingJackExercise } from "../src/exercises/jumpingJack.js";
import { createMuscleView } from "../src/muscleView.js";
import { repFeedback, setSummary, llmSetSummary, cueSpeechText } from "../src/feedback.js";
import { createSpeaker } from "../src/speech.js";
import { loadHistory, addRecord, clearHistory, aggregate } from "../src/history.js";
import { CLIPS, FPS, generateClip, getClipMeta } from "./replayGen.js";
import { PRESET_ORDER, PRESET_LABELS, PRESET_DESC, SLIDERS, thresholdsFor } from "./presets.js";
import { createPoseEngine, releaseEngineData, POSE_CONNECTIONS } from "./poseEngine.js";
import * as Mobile from "./mobile.js";

const $ = (id) => document.getElementById(id);
const CREDITS = window.CREDITS || {};

// ---------------------------------------------------------------- 常量
const EX = {
  squat: {
    create: createSquatExercise,
    name: "深蹲",
    metricName: "膝关节角度",
    unit: "°",
    yMin: 60,
    yMax: 185,
    fmt: (v) => `${Math.round(v)}°`,
    states: { up: "站立", down: "下蹲" },
  },
  jumpingJack: {
    create: createJumpingJackExercise,
    name: "开合跳",
    metricName: "踝距 / 肩宽",
    unit: "×",
    yMin: 0.3,
    yMax: 2.2,
    fmt: (v) => `${v.toFixed(2)}×`,
    states: { closed: "并拢", open: "张开" },
  },
};

const LM_NAMES = [
  "鼻子", "左眼内", "左眼", "左眼外", "右眼内", "右眼", "右眼外", "左耳", "右耳", "嘴左", "嘴右",
  "左肩", "右肩", "左肘", "右肘", "左腕", "右腕", "左小指", "右小指", "左食指", "右食指", "左拇指", "右拇指",
  "左髋", "右髋", "左膝", "右膝", "左踝", "右踝", "左脚跟", "右脚跟", "左脚尖", "右脚尖",
];
const LM_GROUPS = [
  { name: "头部", from: 0, to: 10 },
  { name: "上肢", from: 11, to: 22 },
  { name: "下肢", from: 23, to: 32 },
];
const VIS_THRESHOLD = 0.5; // 与 src/geometry.js allVisible 的默认阈值一致

const TASKS = [
  { id: "t1", text: "看完「深蹲 · 标准」：5 次全部打 ✓（标准档）", go: () => goClip("squat_good", "standard") },
  { id: "t2", text: "在深蹲最低点按暂停（空格），读出右栏的膝角", go: () => goClip("squat_good") },
  { id: "t3", text: "把严格度调到「严格」，让「深蹲 · 标准」出现「不够深」", go: () => goClip("squat_good") },
  { id: "t4", text: "在开合跳片段里找到触发「手臂没举过头顶」的那一段", go: () => goClip("jj_good") },
  { id: "t5", text: "播放「脚出了画面」，看右下角关键点可见度，想想为什么一次也不算", go: () => goClip("squat_cropped") },
  { id: "t6", text: "切到「自定义」，拖一个滑块，看同一片段的判定怎么变", go: () => { setPreset("custom"); $("fineTune").open = true; } },
  { id: "t7", text: "（有摄像头时）切到「我来练」，自己完成 3 次深蹲或开合跳", go: () => setMode("live") },
];

// ---------------------------------------------------------------- 状态
const S = {
  mode: "watch",
  exercise: "squat",
  preset: "standard",
  custom: { squat: null, jumpingJack: null },
  clipId: "squat_good",
  frameIdx: -1,
  playing: true,
  speed: 1,
  autoNext: true,
  acc: 0,
  ex: null, // 当前规则实例
  lastR: null,
  lastLm: null,
  lastRep: null,
  samples: [], // {t, v, ready, phase}
  marks: [], // {t, good}
  stats: { total: 0, good: 0, cueCounts: {}, metrics: [] },
  silent: false,
  clipEndedAt: null,
  // 摄像头
  camOn: false,
  engine: null,
  stream: null,
  liveT0: 0,
  lastVideoTime: -1,
  // 其它
  rafId: 0,
  lastTs: 0,
  timers: new Set(),
  exited: false,
  llmReqId: 0,
  muscleTick: 0,
};

let speaker;
let muscleView;
let sheet = null; // 手机：全屏面板控制器（mobile.js sheets）
const doneTasks = loadTasks();

// ---------------------------------------------------------------- 工具
function later(fn, ms) {
  const id = setTimeout(() => {
    S.timers.delete(id);
    fn();
  }, ms);
  S.timers.add(id);
  return id;
}

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch {
    /* 隐私模式等：忽略 */
  }
  return null;
}

function loadTasks() {
  try {
    const arr = JSON.parse(localStorage.getItem("poseCoach.tasks.v1") || "[]");
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ---------------------------------------------------------------- 规则实例
function thresholds() {
  return thresholdsFor(S.exercise, S.preset, S.custom[S.exercise]);
}

function newExercise() {
  S.ex = EX[S.exercise].create(thresholds());
  S.lastR = null;
  S.lastRep = null;
  S.samples = [];
  S.marks = [];
  S.stats = { total: 0, good: 0, cueCounts: {}, metrics: [] };
}

/** 一帧关键点进规则引擎，更新状态；返回规则结果。 */
function processFrame(lm, t) {
  S.lastLm = lm;
  const r = S.ex.update(lm);
  S.lastR = r;
  S.samples.push({ t, v: r.ready ? r.metricValue : null, phase: r.phase });
  if (S.samples.length > 2400) S.samples.splice(0, S.samples.length - 2400);
  if (r.repCompleted && r.lastRep) {
    const rep = r.lastRep;
    S.lastRep = { ...rep, thresholds: { ...S.ex.thresholds } };
    S.marks.push({ t, good: rep.good });
    S.stats.total += 1;
    if (rep.good) S.stats.good += 1;
    for (const c of rep.cues) S.stats.cueCounts[c] = (S.stats.cueCounts[c] ?? 0) + 1;
    if (rep.metric != null) S.stats.metrics.push(rep.metric);
    if (!S.silent) onRepCompleted(rep);
  }
  return r;
}

function onRepCompleted(rep) {
  const fb = repFeedback(rep);
  setCaption(fb.text, fb.good);
  appendLog(fb.text, fb.good);
  speaker.speak(String(rep.index), { skippable: true });
  if (!rep.good) speaker.speak(cueSpeechText(rep.cues), { dedupeKey: rep.cues.join(",") });
  // 任务判定
  if (S.mode !== "live") {
    if (S.clipId === "squat_good" && S.preset === "strict" && rep.cues.includes("shallow")) completeTask("t3");
    if (rep.cues.includes("arms_low")) completeTask("t4");
  } else if (S.stats.total >= 3) {
    completeTask("t7");
  }
  renderVerdict();
}

// ---------------------------------------------------------------- 回放（看示例 / 练习任务）
function currentClip() {
  return generateClip(S.clipId);
}

function loadClip(id, { keepPlaying = true } = {}) {
  const meta = getClipMeta(id);
  S.clipId = id;
  if (meta.exercise !== S.exercise) {
    S.exercise = meta.exercise;
    $("exerciseSel").value = S.exercise;
    renderPresetUI();
  }
  $("clipSel").value = id;
  $("clipNote").textContent = meta.note;
  S.frameIdx = -1;
  S.acc = 0;
  S.clipEndedAt = null;
  newExercise();
  clearLog();
  setCaption("", null);
  S.playing = keepPlaying;
  updatePlayBtn();
  applyExerciseUI();
  stepTo(0);
}

/** 从头重算到第 idx 帧（拖进度条、改阈值时用）：规则是确定的，重算结果与一路播过来完全一样。 */
function resimTo(idx) {
  const clip = currentClip();
  idx = Math.max(0, Math.min(idx, clip.frames.length - 1));
  newExercise();
  S.silent = true;
  for (let i = 0; i <= idx; i++) processFrame(clip.frames[i], i / FPS);
  S.silent = false;
  S.frameIdx = idx;
  S.clipEndedAt = null;
  if (S.clipId === "squat_good" && S.preset === "strict" && S.stats.cueCounts.shallow) completeTask("t3");
  if (S.stats.cueCounts.arms_low) completeTask("t4");
  rebuildLogFromStats();
  renderAll();
}

/** 向前推进到第 idx 帧（逐帧处理，不跳帧，保证状态机正确）。 */
function stepTo(idx) {
  const clip = currentClip();
  idx = Math.min(idx, clip.frames.length - 1);
  while (S.frameIdx < idx) {
    S.frameIdx += 1;
    processFrame(clip.frames[S.frameIdx], S.frameIdx / FPS);
  }
  if (S.frameIdx >= clip.frames.length - 1 && S.clipEndedAt == null) onClipEnd();
  renderAll();
}

function onClipEnd() {
  S.clipEndedAt = performance.now();
  const meta = getClipMeta(S.clipId);
  const txt =
    S.stats.total === 0
      ? `这一段一次也没有计数：规则需要的关键点可见度不够（看右下角），宁可不计数也不乱判。`
      : setSummary({ exercise: EX[S.exercise].name, total: S.stats.total, goodCount: S.stats.good });
  setCaption(txt, S.stats.total > 0 && S.stats.good === S.stats.total);
  appendLog("【本段小结】" + txt, null);
  if (S.clipId === "squat_good" && S.preset === "standard" && S.stats.total === 5 && S.stats.good === 5) completeTask("t1");
  if (S.clipId === "squat_cropped") completeTask("t5");
  if (S.autoNext && S.playing && S.mode !== "live") {
    later(() => {
      if (S.exited || S.mode === "live" || !S.playing || S.clipId !== meta.id) return;
      const same = CLIPS.filter((c) => c.exercise === meta.exercise);
      const next = same[(same.findIndex((c) => c.id === meta.id) + 1) % same.length];
      loadClip(next.id);
    }, 2200);
  } else {
    S.playing = false;
    updatePlayBtn();
  }
}

function tickWatch(dt) {
  if (!S.playing) return;
  const clip = currentClip();
  if (S.frameIdx >= clip.frames.length - 1) return;
  S.acc += dt * FPS * S.speed;
  const n = Math.floor(S.acc);
  if (n > 0) {
    S.acc -= n;
    stepTo(S.frameIdx + n);
  }
}

function togglePlay() {
  if (S.mode === "live") return;
  const clip = currentClip();
  if (!S.playing && S.frameIdx >= clip.frames.length - 1) {
    loadClip(S.clipId);
    return;
  }
  S.playing = !S.playing;
  updatePlayBtn();
  if (!S.playing && S.exercise === "squat" && S.lastR?.ready && S.lastR.metricValue < 110) completeTask("t2");
}

function stepFrame(delta) {
  if (S.mode === "live") return;
  S.playing = false;
  updatePlayBtn();
  if (delta > 0) stepTo(S.frameIdx + 1);
  else resimTo(S.frameIdx - 1);
  if (S.exercise === "squat" && S.lastR?.ready && S.lastR.metricValue < 110) completeTask("t2");
}

function goClip(id, preset) {
  if (S.mode === "live") setMode("tasks");
  if (preset) setPreset(preset, { silent: true });
  loadClip(id);
}

// ---------------------------------------------------------------- 摄像头（我来练）
async function startCamera() {
  const btn = $("camBtn");
  btn.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("这个页面拿不到摄像头接口。"), { name: "NoApi" });
    }
    showStageHint("正在请求摄像头权限…（浏览器会弹出询问，请点「允许」）");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    if (S.exited || S.mode !== "live") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    S.stream = stream;
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    setStageSize(video.videoWidth || 640, video.videoHeight || 480);
    if (!S.engine) {
      S.engine = await createPoseEngine((m) => showStageHint(m));
      $("engineInfo").textContent = `姿态网络推理后端：${S.engine.delegate === "GPU" ? "GPU（WebGL2）" : "CPU"}${S.engine.note ? "（" + S.engine.note + "）" : ""}`;
    }
    if (S.exited || S.mode !== "live") return stopCamera();
    S.camOn = true;
    S.liveT0 = performance.now();
    S.lastVideoTime = -1;
    newExercise();
    clearLog();
    hideStageHint();
    setCaption("正对摄像头，后退到脚踝也在画面里，然后开始做。", null);
  } catch (err) {
    console.warn(err);
    stopCamera();
    showStageHint(describeCamError(err), true);
  } finally {
    btn.disabled = false;
    updateCamBtn();
  }
}

function stopCamera() {
  if (S.camOn) finishSet();
  S.camOn = false;
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  const video = $("video");
  if (video) video.srcObject = null;
  setStageSize(640, 480);
  updateCamBtn();
}

/** 主画面的内部分辨率和宽高比：示例片段固定 4:3；摄像头按视频真实尺寸（手机竖屏前置摄像头多是竖的）。 */
function setStageSize(w, h) {
  const cv = $("stage");
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  $("stageWrap").style.setProperty("--stage-ar", `${w} / ${h}`);
}

function describeCamError(err) {
  const online = CREDITS.PAGES_URL ? `\n也可以改用在线版（https）：${CREDITS.PAGES_URL}` : "";
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "摄像头没有被允许：请点地址栏左侧的摄像头图标，改成「允许」后再点「开摄像头」。" + online;
    case "NotFoundError":
    case "OverconstrainedError":
      return "没有找到可用的摄像头。没有摄像头也没关系，「看示例」和「练习任务」都能完整使用。";
    case "NotReadableError":
    case "AbortError":
      return "摄像头被别的程序占用了（会议软件、其他标签页），关掉它们后再试。";
    case "NoApi":
      return "这个浏览器在双击打开的本地页面里不提供摄像头（Safari 可能如此）。" + online;
    default:
      return "无法启动：" + (err?.message || String(err)) + online;
  }
}

function tickLive() {
  if (!S.camOn || !S.engine) return;
  const video = $("video");
  if (video.readyState < 2 || video.currentTime === S.lastVideoTime) return;
  S.lastVideoTime = video.currentTime;
  const res = S.engine.detect(video, performance.now());
  const lm = res.landmarks?.[0] ?? null;
  const t = (performance.now() - S.liveT0) / 1000;
  if (lm) processFrame(lm, t);
  else {
    S.lastLm = null;
    S.lastR = null;
    S.samples.push({ t, v: null, phase: null });
  }
  renderAll();
}

function finishSet() {
  if (S.stats.total === 0) return;
  addRecord({
    time: new Date().toISOString(),
    exercise: EX[S.exercise].name,
    total: S.stats.total,
    good: S.stats.good,
    cues: { ...S.stats.cueCounts },
  });
  renderHistory();
  const summary = setSummary({ exercise: EX[S.exercise].name, total: S.stats.total, goodCount: S.stats.good });
  appendLog("【本组小结】" + summary, null);
  setCaption(summary, null);
  if ($("llmToggle").checked) {
    const id = ++S.llmReqId;
    const metricAvg = S.stats.metrics.length
      ? (S.stats.metrics.reduce((a, b) => a + b, 0) / S.stats.metrics.length).toFixed(1)
      : null;
    $("llmStatus").textContent = "正在请求本机大模型点评…";
    llmSetSummary({
      exercise: EX[S.exercise].name,
      total: S.stats.total,
      goodCount: S.stats.good,
      cueCounts: S.stats.cueCounts,
      metricLabel: S.ex.repMetricLabel,
      metricAvg,
    }).then((text) => {
      if (S.exited || id !== S.llmReqId) return;
      if (text) {
        appendLog("【本机大模型点评】" + text, null);
        $("llmStatus").textContent = "已收到本机大模型点评。";
        speaker.speak(text, { dedupeKey: "llm-summary" });
      } else {
        $("llmStatus").textContent = "没连上本机大模型（或超时 8 秒），已使用模板话术。";
      }
    });
  }
  S.stats = { total: 0, good: 0, cueCounts: {}, metrics: [] };
  S.ex.reset();
}

// ---------------------------------------------------------------- 主循环
function frame(ts) {
  if (S.exited) return;
  const dt = S.lastTs ? Math.min((ts - S.lastTs) / 1000, 0.1) : 0;
  S.lastTs = ts;
  if (S.mode === "live") tickLive();
  else tickWatch(dt);
  drawStage();
  S.rafId = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 画面（左栏）
function drawStage() {
  const cv = $("stage");
  const ctx = cv.getContext("2d");
  const w = cv.width;
  const h = cv.height;
  ctx.save();
  if (S.mode === "live" && S.camOn) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage($("video"), 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "rgba(15,23,42,0.35)";
    ctx.fillRect(0, 0, w, h);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#111c33");
    g.addColorStop(1, "#0b1222");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (S.mode !== "live") {
      ctx.strokeStyle = "rgba(148,163,184,0.25)";
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(40, h * 0.93);
      ctx.lineTo(w - 40, h * 0.93);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
  const lm = S.mode === "live" && !S.camOn ? null : S.lastLm;
  if (lm) drawSkeleton(ctx, lm, w, h, S.ex?.required ?? []);
}

function drawSkeleton(ctx, lm, w, h, required) {
  const P = (p) => [(1 - p.x) * w, p.y * h]; // 镜像显示，像照镜子
  const req = new Set(required);
  ctx.lineCap = "round";
  for (const { start, end } of POSE_CONNECTIONS) {
    const a = lm[start];
    const b = lm[end];
    if (!a || !b) continue;
    const low = (a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD;
    ctx.strokeStyle = low ? "rgba(34,211,238,0.25)" : "#22d3ee";
    ctx.lineWidth = low ? 2 : 4;
    ctx.setLineDash(low ? [4, 6] : []);
    const [x1, y1] = P(a);
    const [x2, y2] = P(b);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  lm.forEach((p, i) => {
    const [x, y] = P(p);
    const low = (p.visibility ?? 1) < VIS_THRESHOLD;
    ctx.beginPath();
    ctx.arc(x, y, req.has(i) ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = low ? "rgba(248,250,252,0.3)" : "#f8fafc";
    ctx.fill();
    if (req.has(i)) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = low ? "#f87171" : "#fbbf24";
      ctx.stroke();
    }
  });
  // 角度 / 比值标注
  const r = S.lastR;
  if (!r?.ready) return;
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  if (S.exercise === "squat") {
    const [xa, ya] = P(lm[25]);
    const [xb, yb] = P(lm[26]);
    label(ctx, `膝角（两膝平均）${Math.round(r.metricValue)}°`, (xa + xb) / 2, Math.max(ya, yb) + 34);
  } else {
    const [x1, y1] = P(lm[27]);
    const [x2, y2] = P(lm[28]);
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(x1, y1 + 22);
    ctx.lineTo(x2, y2 + 22);
    ctx.stroke();
    const [s1x, s1y] = P(lm[11]);
    const [s2x, s2y] = P(lm[12]);
    ctx.beginPath();
    ctx.moveTo(s1x, s1y - 14);
    ctx.lineTo(s2x, s2y - 14);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `踝距 ÷ 肩宽 = ${r.metricValue.toFixed(2)}`, Math.min(w - 110, Math.max(x1, x2) + 110), Math.min(h - 60, y1 + 26));
  }
}

function label(ctx, text, x, y) {
  const m = ctx.measureText(text);
  ctx.fillStyle = "rgba(15,23,42,0.8)";
  ctx.fillRect(x - m.width / 2 - 6, y - 17, m.width + 12, 24);
  ctx.fillStyle = "#fde68a";
  ctx.fillText(text, x, y);
}

// ---------------------------------------------------------------- 右栏：规则引擎面板
function renderAll() {
  const r = S.lastR;
  $("countNum").textContent = String(r?.count ?? 0);
  const states = EX[S.exercise].states;
  $("phaseTag").textContent = r ? (r.ready ? states[r.phase] : "关键点不全 · 暂停判定") : "—";
  $("phaseTag").classList.toggle("warn", !!r && !r.ready);
  renderMobStats(r);
  drawCurve();
  renderFsm();
  renderLiveTrackers();
  renderVis();
  if (S.mode !== "live") renderProgress();
  if (++S.muscleTick % 4 === 0) muscleView.highlight(S.ex.muscleGroups, r?.ready ? r.depthRatio : 0);
}

function curveWindow() {
  return 10; // 秒
}

function drawCurve() {
  const cv = $("curve");
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const E = EX[S.exercise];
  const T = S.ex.thresholds;
  const padL = 44;
  const padR = 128;
  const padT = 10;
  const padB = 22;
  const pw = cw - padL - padR;
  const ph = ch - padT - padB;
  const tNow = S.samples.length ? S.samples[S.samples.length - 1].t : 0;
  const tMin = Math.max(0, tNow - curveWindow());
  const tMax = Math.max(curveWindow(), tNow);
  const X = (t) => padL + ((t - (tMax - curveWindow())) / curveWindow()) * pw;
  const Y = (v) => padT + (1 - (v - E.yMin) / (E.yMax - E.yMin)) * ph;

  // 阶段底色
  const downPhase = S.exercise === "squat" ? "down" : "open";
  ctx.fillStyle = "rgba(34,211,238,0.07)";
  let segStart = null;
  for (const s of S.samples) {
    if (s.t < tMin) continue;
    if (s.phase === downPhase && segStart == null) segStart = s.t;
    if (s.phase !== downPhase && segStart != null) {
      ctx.fillRect(X(segStart), padT, X(s.t) - X(segStart), ph);
      segStart = null;
    }
  }
  if (segStart != null) ctx.fillRect(X(segStart), padT, X(tNow) - X(segStart), ph);

  // 网格与坐标
  ctx.strokeStyle = "rgba(148,163,184,0.15)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  const ticks = S.exercise === "squat" ? [60, 90, 120, 150, 180] : [0.5, 1, 1.5, 2];
  for (const v of ticks) {
    ctx.beginPath();
    ctx.moveTo(padL, Y(v));
    ctx.lineTo(padL + pw, Y(v));
    ctx.stroke();
    ctx.fillText(S.exercise === "squat" ? `${v}°` : `${v}`, padL - 6, Y(v) + 4);
  }
  ctx.textAlign = "left";
  ctx.fillText(`最近 ${curveWindow()} 秒 →`, padL, ch - 6);

  // 阈值线（直接标注，不用图例）
  const lines =
    S.exercise === "squat"
      ? [
          { v: T.upAngle, text: `站起线 ${T.upAngle}°`, color: "#94a3b8" },
          { v: T.downAngle, text: `下蹲线 ${T.downAngle}°`, color: "#94a3b8" },
          { v: T.shallowAngle, text: `蹲深线 ${T.shallowAngle}°`, color: "#fbbf24" },
        ]
      : [
          { v: T.openRatio, text: `张开线 ${T.openRatio.toFixed(2)}`, color: "#94a3b8" },
          { v: T.closeRatio, text: `并拢线 ${T.closeRatio.toFixed(2)}`, color: "#94a3b8" },
          { v: T.fullSpread, text: `到位线 ${T.fullSpread.toFixed(2)}`, color: "#fbbf24" },
        ];
  const labelYs = [];
  for (const L of lines) {
    ctx.strokeStyle = L.color;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, Y(L.v));
    ctx.lineTo(padL + pw, Y(L.v));
    ctx.stroke();
    ctx.setLineDash([]);
    let ly = Y(L.v) + 4;
    for (const o of labelYs) if (Math.abs(o - ly) < 13) ly = o + 13;
    labelYs.push(ly);
    ctx.fillStyle = L.color;
    ctx.fillText(L.text, padL + pw + 6, ly);
  }

  // 数据线
  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let pen = false;
  for (const s of S.samples) {
    if (s.t < tMin) continue;
    if (s.v == null) {
      pen = false;
      continue;
    }
    const v = Math.max(E.yMin, Math.min(E.yMax, s.v));
    if (!pen) ctx.moveTo(X(s.t), Y(v));
    else ctx.lineTo(X(s.t), Y(v));
    pen = true;
  }
  ctx.stroke();

  // 每次完成的标记
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const m of S.marks) {
    if (m.t < tMin) continue;
    ctx.fillStyle = m.good ? "#4ade80" : "#f87171";
    ctx.fillText(m.good ? "✓" : "✗", X(m.t), padT + 14);
  }

  // 当前值
  const last = S.samples[S.samples.length - 1];
  if (last && last.v != null) {
    const v = Math.max(E.yMin, Math.min(E.yMax, last.v));
    ctx.fillStyle = "#22d3ee";
    ctx.beginPath();
    ctx.arc(X(last.t), Y(v), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // 悬停读数
  if (curveHover != null) {
    const t = tMax - curveWindow() + ((curveHover - padL) / pw) * curveWindow();
    let best = null;
    for (const s of S.samples) if (best == null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    if (best && curveHover >= padL && curveHover <= padL + pw) {
      ctx.strokeStyle = "rgba(226,232,240,0.5)";
      ctx.beginPath();
      ctx.moveTo(X(best.t), padT);
      ctx.lineTo(X(best.t), padT + ph);
      ctx.stroke();
      const txt = best.v == null ? "关键点不全" : `${E.metricName} ${E.fmt(best.v)}`;
      ctx.font = "12px system-ui, sans-serif";
      const tw = ctx.measureText(txt).width + 12;
      const bx = Math.min(X(best.t) + 8, padL + pw - tw);
      ctx.fillStyle = "rgba(15,23,42,0.92)";
      ctx.fillRect(bx, padT + 20, tw, 22);
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "left";
      ctx.fillText(txt, bx + 6, padT + 35);
    }
  }
  $("curveValue").textContent = last && last.v != null ? E.fmt(last.v) : "—";
}
let curveHover = null;

function renderFsm() {
  const E = EX[S.exercise];
  const T = S.ex.thresholds;
  const isSquat = S.exercise === "squat";
  const [a, b] = isSquat ? ["up", "down"] : ["closed", "open"];
  const phase = S.lastR?.ready ? S.lastR.phase : null;
  const key = `${S.exercise}|${JSON.stringify(T)}`;
  const box = $("fsm");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    const go = isSquat ? `膝角 &lt; ${T.downAngle}°` : `踝距/肩宽 &gt; ${T.openRatio.toFixed(2)}`;
    const back = isSquat ? `膝角 &gt; ${T.upAngle}° → 计数 +1` : `踝距/肩宽 &lt; ${T.closeRatio.toFixed(2)} → 计数 +1`;
    box.innerHTML = `
      <div class="fsm-state" data-state="${a}">${E.states[a]}</div>
      <div class="fsm-arrows">
        <div class="fsm-arrow fwd"><span>${go}</span><i>→</i></div>
        <div class="fsm-arrow back"><i>←</i><span>${back}</span></div>
      </div>
      <div class="fsm-state" data-state="${b}">${E.states[b]}</div>`;
  }
  box.querySelectorAll(".fsm-state").forEach((el) => el.classList.toggle("on", el.dataset.state === phase));
  box.classList.toggle("paused", !S.lastR?.ready);
}

function renderLiveTrackers() {
  const r = S.lastR;
  const el = $("fsmLive");
  if (!r) return (el.textContent = "等待关键点…");
  if (!r.ready) return (el.textContent = "关键点可见度不够，状态机暂停，不计数也不判错。");
  if (S.exercise === "squat") {
    el.textContent =
      r.phase === "down"
        ? `本次下蹲中：最低膝角 ${Math.round(r.repMinKneeAngle)}°，最小膝距/踝距 ${r.repMinValgusRatio.toFixed(2)}`
        : `站立中：膝角 ${Math.round(r.metricValue)}°，膝距/踝距 ${r.valgusRatio.toFixed(2)}`;
  } else {
    el.textContent =
      r.phase === "open"
        ? `本次张开中：峰值 ${r.repMaxSpread.toFixed(2)}×，双腕${r.repArmsUpSeen ? "已" : "还没"}高过鼻子`
        : `并拢中：踝距/肩宽 ${r.metricValue.toFixed(2)}×，双腕${r.armsUp ? "高于" : "低于"}鼻子`;
  }
}

function renderVerdict() {
  const el = $("verdict");
  const rep = S.lastRep;
  if (!rep) {
    el.innerHTML = `<p class="muted">还没有完成的动作。每完成一次，这里逐条列出规则用到的数值和阈值。</p>`;
    return;
  }
  const T = rep.thresholds;
  const rows =
    S.exercise === "squat"
      ? [
          {
            rule: "蹲得够深",
            val: `最低膝角 ${rep.minKneeAngle}°`,
            need: `≤ ${T.shallowAngle}°`,
            ok: !rep.cues.includes("shallow"),
            bad: "不够深",
          },
          {
            rule: "膝盖不内扣",
            val: `膝距/踝距 ${rep.minValgusRatio.toFixed(2)}`,
            need: `≥ ${T.valgusRatio.toFixed(2)}`,
            ok: !rep.cues.includes("valgus"),
            bad: "膝盖内扣",
          },
        ]
      : [
          {
            rule: "手举过头顶",
            val: `双腕曾高于鼻子：${rep.armsUp ? "是" : "否"}`,
            need: "必须为「是」",
            ok: !rep.cues.includes("arms_low"),
            bad: "手没举过头",
          },
          {
            rule: "腿跳开到位",
            val: `张开峰值 ${rep.maxSpread.toFixed(2)}×`,
            need: `≥ ${T.fullSpread.toFixed(2)}×`,
            ok: !rep.cues.includes("narrow"),
            bad: "张开不足",
          },
        ];
  const fb = repFeedback(rep);
  el.innerHTML = `
    <div class="verdict-head ${rep.good ? "good" : "warn"}">第 ${rep.index} 次：${rep.good ? "✓ 标准" : "✗ 需要改进"}</div>
    <table class="verdict-table">
      <tr><th>规则</th><th>测到的值</th><th>阈值</th><th>结果</th></tr>
      ${rows
        .map(
          (r) =>
            `<tr><td>${r.rule}</td><td>${esc(r.val)}</td><td>${esc(r.need)}</td><td class="${r.ok ? "good" : "warn"}">${r.ok ? "✓ 通过" : "✗ " + r.bad}</td></tr>`,
        )
        .join("")}
    </table>
    <p class="verdict-say">教练话术（模板）：${esc(fb.text.replace(/^第 \d+ 次：/, ""))}</p>`;
}

function buildVis() {
  const el = $("visGrid");
  el.innerHTML = LM_GROUPS.map(
    (g) => `<div class="vis-group"><div class="vis-gname">${g.name}<small>${g.to - g.from + 1} 点</small></div><div class="vis-bars">${Array.from(
      { length: g.to - g.from + 1 },
      (_, k) => {
        const i = g.from + k;
        return `<div class="vis-bar" data-i="${i}" title="${i} ${LM_NAMES[i]}"><span class="vis-fill"></span><em>${LM_NAMES[i]}</em></div>`;
      },
    ).join("")}</div></div>`,
  ).join("");
}

function renderVis() {
  const lm = S.mode === "live" && !S.camOn ? null : S.lastLm;
  const req = new Set(S.ex?.required ?? []);
  let reqOk = 0;
  document.querySelectorAll("#visGrid .vis-bar").forEach((bar) => {
    const i = Number(bar.dataset.i);
    const v = lm?.[i]?.visibility ?? 0;
    const fill = bar.firstElementChild;
    fill.style.height = `${Math.round(v * 100)}%`;
    bar.classList.toggle("req", req.has(i));
    bar.classList.toggle("low", v < VIS_THRESHOLD);
    if (req.has(i) && v >= VIS_THRESHOLD) reqOk++;
  });
  $("visSummary").textContent = lm
    ? `规则需要的 ${req.size} 个点（黄框）里有 ${reqOk} 个可见度 ≥ ${VIS_THRESHOLD}${reqOk === req.size ? "，可以判定。" : "，不够：暂停判定。"}`
    : "还没有关键点。";
}

// ---------------------------------------------------------------- 左栏小部件
function setCaption(text, good) {
  const el = $("caption");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  el.classList.toggle("good", good === true);
  el.classList.toggle("warn", good === false);
}

function appendLog(text, good) {
  const li = document.createElement("li");
  li.textContent = text;
  if (good === true) li.className = "good";
  if (good === false) li.className = "warn";
  $("log").prepend(li);
  while ($("log").children.length > 30) $("log").lastChild.remove();
}

function clearLog() {
  $("log").innerHTML = "";
}

function rebuildLogFromStats() {
  clearLog();
  if (S.lastRep) {
    const fb = repFeedback(S.lastRep);
    setCaption(fb.text, fb.good);
  } else setCaption("", null);
  renderVerdict();
}

function showStageHint(text, isError = false) {
  const el = $("stageHint");
  el.textContent = text;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
}

function hideStageHint() {
  $("stageHint").classList.add("hidden");
}

function renderProgress() {
  const clip = currentClip();
  const n = clip.frames.length;
  const pr = $("progress");
  pr.max = String(n - 1);
  if (document.activeElement !== pr) pr.value = String(Math.max(0, S.frameIdx));
  $("timeText").textContent = `${(Math.max(0, S.frameIdx) / FPS).toFixed(1)} / ${((n - 1) / FPS).toFixed(1)} 秒`;
}

function updatePlayBtn() {
  $("playBtn").textContent = S.playing ? "⏸ 暂停" : "▶ 播放";
  updateMobBar();
}

function updateCamBtn() {
  $("camBtn").textContent = S.camOn ? "■ 关摄像头" : "● 开摄像头";
  $("resetBtn").disabled = !S.camOn;
  updateMobBar();
}

/** 手机竖屏：主画面下方的大按钮文字（电脑上这些元素不显示，但状态照样维护）。 */
function updateMobBar() {
  if (S.mode === "live") {
    $("mStart").textContent = S.camOn ? "■ 关摄像头" : "● 开摄像头";
    $("mReplay").textContent = "看示例";
  } else {
    $("mStart").textContent = S.playing ? "⏸ 暂停" : "▶ 开始";
    $("mReplay").textContent = "⏮ 回放";
  }
  $("mSwap").textContent = S.exercise === "squat" ? "换开合跳" : "换深蹲";
}

/** 手机竖屏：计数 / 状态大字。 */
function renderMobStats(r) {
  const E = EX[S.exercise];
  $("mCount").textContent = String(r?.count ?? 0);
  const line = $("mPhase").parentElement;
  if (S.mode === "live" && !S.camOn) {
    $("mPhase").textContent = E.name;
    $("mMetric").textContent = "摄像头未开";
    line.classList.remove("warn");
  } else if (!r) {
    $("mPhase").textContent = E.name;
    $("mMetric").textContent = "等待关键点…";
    line.classList.remove("warn");
  } else if (!r.ready) {
    $("mPhase").textContent = "关键点不全";
    $("mMetric").textContent = "暂停判定";
    line.classList.add("warn");
  } else {
    $("mPhase").textContent = `${E.name} · ${E.states[r.phase]}`;
    $("mMetric").textContent = `${E.metricName} ${E.fmt(r.metricValue)}`;
    line.classList.remove("warn");
  }
  const v = $("mVerdict");
  const cap = $("caption");
  v.textContent = cap.classList.contains("hidden") ? "" : cap.textContent;
  v.classList.toggle("good", cap.classList.contains("good"));
  v.classList.toggle("warn", cap.classList.contains("warn"));
}

function renderHistory() {
  const records = loadHistory();
  const agg = aggregate(records);
  $("historyTotals").textContent =
    agg.sets === 0
      ? "暂无记录。在「我来练」里练完一组（点「结束本组」或关摄像头）会自动记一条，只存在这台电脑的浏览器里。"
      : `累计 ${agg.sets} 组 / ${agg.reps} 次，标准 ${agg.goodReps} 次（${Math.round((agg.goodReps / Math.max(agg.reps, 1)) * 100)}%）`;
  $("historyList").innerHTML = records
    .slice(0, 10)
    .map((r) => {
      const t = new Date(r.time);
      const when = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      return `<li>${when} · ${esc(r.exercise)} ${r.total} 次（标准 ${r.good}）</li>`;
    })
    .join("");
}

// ---------------------------------------------------------------- 预设 / 滑块
function renderPresetUI() {
  document.querySelectorAll("#presetBtns button").forEach((b) => b.classList.toggle("on", b.dataset.preset === S.preset));
  $("presetDesc").textContent = PRESET_DESC[S.exercise][S.preset];
  const T = thresholds();
  $("sliders").innerHTML = SLIDERS[S.exercise]
    .map(
      (s) => `<label class="slider"><span>${s.label}</span>
        <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${T[s.key]}" data-key="${s.key}">
        <b>${fmtSlider(s, T[s.key])}</b></label>`,
    )
    .join("");
}

function fmtSlider(s, v) {
  return s.step >= 1 ? `${Math.round(v)}${s.unit}` : `${Number(v).toFixed(2)}${s.unit}`;
}

function setPreset(p, { silent = false } = {}) {
  if (p === "custom" && !S.custom[S.exercise]) S.custom[S.exercise] = { ...thresholdsFor(S.exercise, S.preset) };
  S.preset = p;
  renderPresetUI();
  if (!silent) applyThresholdChange();
}

function applyThresholdChange() {
  if (S.mode === "live") {
    // 摄像头模式：换规则实例，计数从 0 开始
    finishSet();
    newExercise();
    renderVerdict();
  } else {
    resimTo(S.frameIdx);
  }
}

// ---------------------------------------------------------------- 模式切换
function setMode(mode) {
  if (mode === S.mode) return;
  const prev = S.mode;
  S.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  if (prev === "live") {
    stopCamera();
    hideStageHint();
    loadClip(S.clipId);
  }
  updateMobBar();
  if (mode === "live") {
    S.playing = false;
    newExercise();
    clearLog();
    setCaption("", null);
    S.lastLm = null;
    S.lastR = null;
    renderVerdict();
    showStageHint("点下方「● 开摄像头」开始。\n正对摄像头，后退到从头到脚踝都在画面里。\n摄像头画面只在这台电脑上处理，不会上传。");
    updateCamBtn();
    renderAll();
  }
  renderTasks();
}

function applyExerciseUI() {
  const E = EX[S.exercise];
  $("curveTitle").textContent = `${E.metricName}（实时）`;
  $("visHint").textContent =
    S.exercise === "squat" ? "深蹲只用髋、膝、踝 6 个点（黄框）。" : "开合跳用鼻、肩、腕、踝 7 个点（黄框）。";
  muscleView.highlight(S.ex.muscleGroups, 0);
  renderVerdict();
}

function onExerciseChange(kind) {
  if (S.mode === "live") {
    finishSet();
    S.exercise = kind;
    renderPresetUI();
    newExercise();
    applyExerciseUI();
    return;
  }
  const first = CLIPS.find((c) => c.exercise === kind);
  S.exercise = kind;
  renderPresetUI();
  loadClip(first.id);
  updateMobBar();
}

// ---------------------------------------------------------------- 任务清单
function completeTask(id) {
  if (doneTasks.has(id)) return;
  doneTasks.add(id);
  store("poseCoach.tasks.v1", JSON.stringify([...doneTasks]));
  renderTasks();
  const t = TASKS.find((x) => x.id === id);
  if (t && S.mode === "tasks") toast(`✓ 完成任务：${t.text}`);
}

function renderTasks() {
  const el = $("taskList");
  el.innerHTML = TASKS.map(
    (t, i) =>
      `<li class="${doneTasks.has(t.id) ? "done" : ""}"><span class="tick">${doneTasks.has(t.id) ? "✓" : i + 1}</span><span class="ttext">${t.text}</span><button class="mini" data-task="${t.id}">去做</button></li>`,
  ).join("");
  $("taskCount").textContent = `${doneTasks.size} / ${TASKS.length}`;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  later(() => el.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------- 帮助 / 悬停提示（带小动画）
const miniPlayers = new Map();

function startMini(canvas, clipId) {
  const clip = generateClip(clipId);
  const st = { i: 0, raf: 0 };
  const ctx = canvas.getContext("2d");
  const draw = () => {
    if (S.exited) return;
    st.i = (st.i + 1) % clip.frames.length;
    const lm = clip.frames[st.i];
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0b1222";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#4ade80";
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.setLineDash([]);
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 3;
    for (const { start, end } of POSE_CONNECTIONS) {
      const a = lm[start];
      const b = lm[end];
      ctx.beginPath();
      ctx.moveTo((1 - a.x) * w, a.y * h);
      ctx.lineTo((1 - b.x) * w, b.y * h);
      ctx.stroke();
    }
    st.raf = requestAnimationFrame(draw);
  };
  st.raf = requestAnimationFrame(draw);
  miniPlayers.set(canvas, st);
}

function stopMini(canvas) {
  const st = miniPlayers.get(canvas);
  if (st) cancelAnimationFrame(st.raf);
  miniPlayers.delete(canvas);
}

function openHelp() {
  $("helpModal").classList.remove("hidden");
  startMini($("helpMini"), S.exercise === "squat" ? "squat_good" : "jj_good");
}

function closeHelp() {
  $("helpModal").classList.add("hidden");
  stopMini($("helpMini"));
  // 第一次看完说明后，示例从头播放（说明打开期间的那几秒别错过）
  if (store("poseCoach.helpSeen") !== "1" && S.mode !== "live") loadClip(S.clipId);
  store("poseCoach.helpSeen", "1");
}

function bindTooltips() {
  const tip = $("tooltip");
  let mini = null;
  document.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      const anim = el.dataset.tipAnim;
      tip.innerHTML = `${anim ? '<canvas width="150" height="112" class="tip-mini"></canvas>' : ""}<div>${esc(el.dataset.tip)}</div>`;
      tip.classList.add("show");
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
      const below = r.bottom + 8;
      tip.style.top = `${below + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 8 : below}px`;
      if (anim) {
        mini = tip.querySelector("canvas");
        startMini(mini, anim);
      }
    });
    el.addEventListener("mouseleave", () => {
      tip.classList.remove("show");
      if (mini) stopMini(mini);
      mini = null;
    });
  });
}

// ---------------------------------------------------------------- 退出
function exitApp() {
  if (S.exited) return;
  S.exited = true;
  cancelAnimationFrame(S.rafId);
  for (const id of S.timers) clearTimeout(id);
  S.timers.clear();
  for (const c of [...miniPlayers.keys()]) stopMini(c);
  try {
    speechSynthesis.cancel();
  } catch {
    /* 忽略 */
  }
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  if (S.engine) S.engine.close();
  S.engine = null;
  releaseEngineData();
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", onResize);
  Mobile.destroy();
  S.samples = [];
  S.marks = [];
  S.lastLm = null;
  try {
    window.close();
  } catch {
    /* 忽略 */
  }
  setTimeout(() => {
    document.body.innerHTML =
      '<div class="endpage"><h1>已停止运行</h1><p>所有计算都已结束，可以直接关闭这个标签页。</p></div>';
    document.body.dataset.mode = "ended";
  }, 150);
}

// ---------------------------------------------------------------- 事件绑定
function onKey(e) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
    if (e.key !== "Escape") return;
  }
  if (!$("helpModal").classList.contains("hidden")) {
    if (e.key === "Escape" || e.key === "h" || e.key === "H") closeHelp();
    return;
  }
  if (e.key === "h" || e.key === "H") openHelp();
  else if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "ArrowRight") stepFrame(1);
  else if (e.key === "ArrowLeft") stepFrame(-1);
  else if (e.key === "b" || e.key === "B") {
    $("bigScreen").checked = !$("bigScreen").checked;
    applyBigScreen();
  }
}

function onResize() {
  drawCurve();
}

function applyBigScreen() {
  document.body.classList.toggle("big", $("bigScreen").checked);
  store("poseCoach.big", $("bigScreen").checked ? "1" : "0");
  requestAnimationFrame(drawCurve);
}

function bind() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  $("exerciseSel").addEventListener("change", (e) => onExerciseChange(e.target.value));
  $("clipSel").addEventListener("change", (e) => loadClip(e.target.value));
  $("playBtn").addEventListener("click", togglePlay);
  $("stepBtn").addEventListener("click", () => stepFrame(1));
  $("backBtn").addEventListener("click", () => stepFrame(-1));
  $("restartBtn").addEventListener("click", () => loadClip(S.clipId));
  document.querySelectorAll("#speedBtns button").forEach((b) =>
    b.addEventListener("click", () => {
      S.speed = Number(b.dataset.speed);
      document.querySelectorAll("#speedBtns button").forEach((x) => x.classList.toggle("on", x === b));
    }),
  );
  $("autoNext").addEventListener("change", (e) => (S.autoNext = e.target.checked));
  $("progress").addEventListener("input", (e) => {
    S.playing = false;
    updatePlayBtn();
    resimTo(Number(e.target.value));
  });
  document.querySelectorAll("#presetBtns button").forEach((b) => b.addEventListener("click", () => setPreset(b.dataset.preset)));
  $("sliders").addEventListener("input", (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement)) return;
    if (S.preset !== "custom") setPreset("custom", { silent: true });
    S.custom[S.exercise] = { ...S.custom[S.exercise], [inp.dataset.key]: Number(inp.value) };
    const def = SLIDERS[S.exercise].find((s) => s.key === inp.dataset.key);
    inp.nextElementSibling.textContent = fmtSlider(def, Number(inp.value));
    document.querySelectorAll("#presetBtns button").forEach((b) => b.classList.toggle("on", b.dataset.preset === "custom"));
    $("presetDesc").textContent = PRESET_DESC[S.exercise].custom;
    completeTask("t6");
    applyThresholdChange();
  });
  $("camBtn").addEventListener("click", () => (S.camOn ? stopCamera() : startCamera()));
  $("resetBtn").addEventListener("click", () => {
    finishSet();
    newExercise();
    renderVerdict();
  });
  $("clearHistoryBtn").addEventListener("click", () => {
    clearHistory();
    renderHistory();
  });
  $("speechToggle").addEventListener("change", (e) => speaker.setEnabled(e.target.checked));
  $("llmToggle").addEventListener("change", (e) => {
    $("llmStatus").textContent = e.target.checked
      ? "已打开：每组结束时尝试请求本机 Ollama（需另外安装并允许跨域，见 README）；连不上就用模板话术。"
      : "关闭中：组总结使用模板话术。";
  });
  $("helpBtn").addEventListener("click", openHelp);
  $("helpClose").addEventListener("click", closeHelp);
  $("exitBtn").addEventListener("click", exitApp);
  $("bigScreen").addEventListener("change", applyBigScreen);
  $("taskList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-task]");
    if (b) TASKS.find((t) => t.id === b.dataset.task).go();
  });
  $("taskReset").addEventListener("click", () => {
    doneTasks.clear();
    store("poseCoach.tasks.v1", "[]");
    renderTasks();
  });
  const cv = $("curve");
  cv.addEventListener("mousemove", (e) => {
    curveHover = e.offsetX;
    drawCurve();
  });
  cv.addEventListener("mouseleave", () => {
    curveHover = null;
    drawCurve();
  });
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  bindTooltips();
  bindMobile();
}

/** 手机竖屏：大按钮、☰ 菜单、全屏面板、横屏提示、防误触（mobile.js）。电脑上这些元素不显示。 */
function bindMobile() {
  Mobile.detect({ onChange: () => requestAnimationFrame(drawCurve) });
  Mobile.menu($("menuBtn"), $("menu"));
  sheet = Mobile.sheets($("panelClose"), () => requestAnimationFrame(drawCurve));
  Mobile.rotateHint($("rotateOk"));
  Mobile.pressFeedback($("mobBar"), ".mbtn");
  Mobile.guard(document.body, {});
  $("mStart").addEventListener("click", () => {
    if (S.mode === "live") S.camOn ? stopCamera() : startCamera();
    else togglePlay();
  });
  $("mSwap").addEventListener("click", () => {
    const next = S.exercise === "squat" ? "jumpingJack" : "squat";
    $("exerciseSel").value = next;
    onExerciseChange(next);
    updateMobBar();
  });
  $("mReplay").addEventListener("click", () => {
    if (S.mode === "live") setMode("watch");
    else loadClip(S.clipId);
  });
  $("mPanel").addEventListener("click", () => sheet.toggle("panel"));
  $("menuHelp").addEventListener("click", openHelp);
  $("menuPanel").addEventListener("click", () => sheet.open("panel"));
  $("menuSettings").addEventListener("click", () => {
    $("moreSettings").open = true;
    $("moreSettings").scrollIntoView({ block: "start", behavior: "smooth" });
  });
  $("menuExit").addEventListener("click", exitApp);
}

// ---------------------------------------------------------------- 启动
function init() {
  speaker = createSpeaker();
  speaker.setEnabled(false); // 语音默认关（课堂外放时不突然出声）
  if (!speaker.supported) {
    $("speechToggle").disabled = true;
    $("speechLabel").textContent = "语音播报（这个浏览器不支持）";
  }
  muscleView = createMuscleView($("muscleFront"), $("muscleBack"));
  $("clipSel").innerHTML = CLIPS.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  $("presetBtns").innerHTML = PRESET_ORDER.map((p) => `<button data-preset="${p}">${PRESET_LABELS[p]}</button>`).join("");
  buildVis();
  // 页脚：纯文字署名
  const f = CREDITS;
  $("footer").innerHTML = [
    f.SERIES_NAME_ZH ? `属于「${esc(f.SERIES_NAME_ZH)}」系列` : "",
    f.AUTHOR ? `作者 ${esc(f.AUTHOR)}${f.AUTHOR_EMAIL ? "（" + esc(f.AUTHOR_EMAIL) + "）" : ""}` : "",
    f.UNIVERSITY_EN ? esc(f.UNIVERSITY_EN) : "",
    f.UNIVERSITY_KO ? esc(f.UNIVERSITY_KO) : "",
    "代码 MIT · 文档 CC BY 4.0",
    "姿态模型 MediaPipe Pose Landmarker（Apache-2.0）· 肌肉图 body-muscles（Apache-2.0）",
  ]
    .filter(Boolean)
    .join(" · ");
  if (store("poseCoach.big") === "1") {
    $("bigScreen").checked = true;
    document.body.classList.add("big");
  }
  document.body.dataset.mode = "watch";
  bind();
  renderPresetUI();
  renderHistory();
  renderTasks();
  updateCamBtn();
  loadClip("squat_good");
  if (store("poseCoach.helpSeen") !== "1") openHelp();
  S.rafId = requestAnimationFrame(frame);
}

// 给自动化测试用的只读窗口（不影响正常使用）
window.__poseCoach = {
  state: () => ({
    mode: S.mode,
    exercise: S.exercise,
    preset: S.preset,
    clipId: S.clipId,
    frameIdx: S.frameIdx,
    playing: S.playing,
    count: S.lastR?.count ?? 0,
    stats: { ...S.stats },
    lastRep: S.lastRep,
    camOn: S.camOn,
    engine: S.engine ? S.engine.delegate : null,
    exited: S.exited,
    touchp: document.body.classList.contains("touchp"),
    sheet: sheet ? sheet.current() : null,
    stage: $("stage") ? { w: $("stage").width, h: $("stage").height } : null, // 退出后画布已不在
  }),
  seekEnd: () => {
    S.playing = false;
    stepTo(currentClip().frames.length - 1);
  },
  restart: () => loadClip(S.clipId, { keepPlaying: false }),
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

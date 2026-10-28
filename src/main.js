/**
 * main.js —— 编排层：把「摄像头 → 姿态估计 → 动作规则 → 肌肉高亮 + 反馈 + 语音 + 历史」串成闭环。
 *
 * 数据流（每一帧）：
 *   摄像头视频帧
 *     → poseEstimator.detect() 得到 33 个关键点
 *     → drawSkeleton() 画骨架
 *     → exercise.update(landmarks) 算角度/计数/纠错（结构化结果）
 *     → muscleView.highlight() 按动作幅度高亮肌群
 *     → 完成一次时 feedback 生成教练话术、语音播报、更新 UI
 *
 * 一组结束（停止 / 重置 / 切换动作）时：
 *     → history.addRecord() 存 localStorage
 *     → llmSetSummary() 异步请本地 Ollama 点评；不可用时保持模板总结，UI 不报错
 */
import "./style.css";
import { createPoseEstimator, explainError } from "./poseEstimator.js";
import { drawSkeleton } from "./skeleton.js";
import { createSquatExercise } from "./exercises/squat.js";
import { createJumpingJackExercise } from "./exercises/jumpingJack.js";
import { createMuscleView } from "./muscleView.js";
import { repFeedback, setSummary, llmSetSummary, cueSpeechText } from "./feedback.js";
import { createSpeaker } from "./speech.js";
import { loadHistory, addRecord, clearHistory, aggregate } from "./history.js";

// ---- 可选动作注册表（新增动作 = exercises/ 下加一个文件 + 这里登记一行 + html 加一个 option）----
const EXERCISES = {
  squat: createSquatExercise,
  jumpingJack: createJumpingJackExercise,
};

// ---- 取 DOM ----
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const hint = document.getElementById("hint");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const exerciseSelect = document.getElementById("exerciseSelect");
const speechBtn = document.getElementById("speechBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const el = {
  count: document.getElementById("count"),
  phase: document.getElementById("phase"),
  metric: document.getElementById("kneeAngle"),
  metricLabel: document.getElementById("metricLabel"),
  exerciseName: document.getElementById("exerciseName"),
  depthFill: document.getElementById("depthFill"),
  feedbackNow: document.getElementById("feedbackNow"),
  feedbackLog: document.getElementById("feedbackLog"),
  summary: document.getElementById("summary"),
  historyTotals: document.getElementById("historyTotals"),
  historyList: document.getElementById("historyList"),
};

// ---- 模块实例 ----
let exercise = EXERCISES[exerciseSelect.value]();
const muscleView = createMuscleView(
  document.getElementById("muscleFront"),
  document.getElementById("muscleBack")
);
const speaker = createSpeaker(); // 语音播报（默认开）
let pose = null; // 姿态估计器（首次开始时才加载，避免一进页面就下载模型）

// ---- 运行状态 ----
let running = false;
let rafId = null;
let lastVideoTime = -1;
// 本组统计：总次数 / 标准次数 / 各纠错规则触发次数 / 每次的深度指标（喂 LLM 的「深度统计」）
let stats = newStats();
let llmRequestId = 0; // 迟到的 LLM 响应只在「还没开始新一组动作」时允许写 UI（乱序/串组保护）

function newStats() {
  return { total: 0, good: 0, cueCounts: {}, metrics: [] };
}

applyExerciseToUI();
renderHistory();

// ============ 控件事件 ============
startBtn.addEventListener("click", () => {
  if (running) {
    stop();
  } else {
    start();
  }
});

resetBtn.addEventListener("click", () => {
  finishSet(); // 当前组先入历史 + 请 LLM 点评
  resetCounter("已重置，开始新的一组吧！");
});

exerciseSelect.addEventListener("change", () => {
  finishSet(); // 旧动作的组先结算
  exercise = EXERCISES[exerciseSelect.value]();
  applyExerciseToUI();
  resetCounter(`已切换到「${exercise.name}」。${exercise.instructions}`);
});

speechBtn.addEventListener("click", () => {
  if (!speaker.supported) return;
  speaker.setEnabled(!speaker.isEnabled());
  updateSpeechBtn();
});

clearHistoryBtn.addEventListener("click", () => {
  clearHistory();
  renderHistory();
});

if (!speaker.supported) {
  speechBtn.disabled = true;
  speechBtn.textContent = "🔇 不支持语音";
}

// ============ 启动 / 停止 ============
async function start() {
  try {
    setHint("正在初始化摄像头与姿态模型…（模型已在本地，几秒即可）");
    startBtn.disabled = true;

    // 1) 打开摄像头（4:3，和显示框比例一致，减少裁切错位）
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "当前页面无法使用摄像头：浏览器只允许在 localhost 或 https 页面打开摄像头，请用 http://localhost:端口 访问。",
      );
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    // 画布像素尺寸对齐到摄像头实际分辨率
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;

    // 2) 加载姿态模型（只加载一次）
    if (!pose) {
      setHint("摄像头已打开，正在加载姿态模型…");
      pose = await createPoseEstimator();
      showEngineInfo(pose);
    }

    running = true;
    startBtn.textContent = "停止";
    startBtn.disabled = false;
    resetBtn.disabled = false;
    setHint("", true);
    loop();
  } catch (err) {
    console.error(err);
    // 失败时释放摄像头，避免指示灯常亮、下次重试报「被占用」
    const s = video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    setHint("无法启动：" + describeError(err));
    startBtn.disabled = false;
  }
}

function showEngineInfo(p) {
  const box = document.getElementById("engineInfo");
  if (!box) return;
  box.textContent =
    p.delegate === "GPU" ? "推理后端：GPU（WebGL2）" : `推理后端：CPU${p.note ? `（${p.note}）` : ""}`;
  box.classList.toggle("warn", p.delegate !== "GPU");
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  startBtn.textContent = "开始";
  setHint("已停止，点击「开始」继续。");
  finishSet(); // 停止 = 一组结束：入历史 + 请 LLM 点评
  // 一组已结算完毕，计数器归零迎接下一组（反馈/总结先留在屏幕上供回看）
  exercise.reset();
  stats = newStats();
}

function resetCounter(message) {
  exercise.reset();
  stats = newStats();
  el.count.textContent = "0";
  el.feedbackLog.innerHTML = "";
  el.summary.textContent = "";
  setFeedback(message, null);
}

// ============ 一组结束：入历史 + LLM 点评 ============
function finishSet() {
  if (stats.total === 0) return; // 没练就不记

  // 1) 存训练历史（localStorage）
  addRecord({
    time: new Date().toISOString(),
    exercise: exercise.name,
    total: stats.total,
    good: stats.good,
    cues: { ...stats.cueCounts },
  });
  renderHistory();

  // 2) 异步请本地 Ollama 给口语化点评；拿不到就保持现有模板总结（无缝降级）
  requestLlmSummary();
}

function requestLlmSummary() {
  const id = ++llmRequestId;
  const metricAvg = stats.metrics.length
    ? (stats.metrics.reduce((a, b) => a + b, 0) / stats.metrics.length).toFixed(1)
    : null;

  llmSetSummary({
    exercise: exercise.name,
    total: stats.total,
    goodCount: stats.good,
    cueCounts: stats.cueCounts,
    metricLabel: exercise.repMetricLabel,
    metricAvg,
  }).then((text) => {
    // 只有「最新一次请求」允许写 UI；期间用户已重置/切动作则丢弃
    if (text && id === llmRequestId) {
      el.summary.textContent = `🤖 AI 教练：${text}`;
      speaker.speak(text, { dedupeKey: "llm-summary" });
    }
    // text 为 null = Ollama 不可用/超时 → 什么都不做，模板总结还在，UI 不报错
  });
}

// ============ 训练历史渲染 ============
function renderHistory() {
  const records = loadHistory();
  const agg = aggregate(records);

  el.historyTotals.textContent = agg.sets === 0
    ? "暂无历史记录。完成一组训练（按「停止」或「重置」）后会自动记录。"
    : `累计 ${agg.sets} 组 / ${agg.reps} 次，标准 ${agg.goodReps} 次（${Math.round((agg.goodReps / Math.max(agg.reps, 1)) * 100)}%）`;

  el.historyList.innerHTML = "";
  for (const r of records.slice(0, 10)) {
    const li = document.createElement("li");
    const t = new Date(r.time);
    const when = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    const cueCount = Object.values(r.cues ?? {}).reduce((a, b) => a + b, 0);
    li.textContent = `${when} · ${r.exercise} ${r.total} 次（标准 ${r.good}${cueCount ? `，纠错 ${cueCount}` : ""}）`;
    el.historyList.appendChild(li);
  }
}

// ============ 主循环 ============
function loop() {
  if (!running) return;

  // 只在视频出现新帧时才检测（detectForVideo 要求时间戳单调递增）
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = pose.detect(video, performance.now());
    const landmarks = result.landmarks?.[0];

    drawSkeleton(ctx, landmarks);

    if (landmarks) {
      const r = exercise.update(landmarks);
      render(r);
    }
  }

  rafId = requestAnimationFrame(loop);
}

// ============ 把结构化结果渲染到 UI ============
function render(r) {
  // 关键点不全（没露出全身）时，提示并淡化肌肉
  if (!r.ready) {
    el.phase.textContent = "—";
    el.metric.textContent = "—";
    el.depthFill.style.width = "0%";
    muscleView.highlight(exercise.muscleGroups, 0);
    setHint("请正对摄像头后退一点，让全身（到脚踝）都进入画面", false);
    return;
  }
  setHint("", true);

  el.count.textContent = String(r.count);
  el.phase.textContent = r.phaseLabel;
  el.metric.textContent = r.metricText ?? "—";
  el.depthFill.style.width = `${Math.round(r.depthRatio * 100)}%`;

  // 肌肉随动作幅度高亮
  muscleView.highlight(exercise.muscleGroups, r.depthRatio);

  // 完成一次 → 统计 + 反馈 + 语音
  if (r.repCompleted && r.lastRep) {
    llmRequestId++; // 新动作已开始，作废上一组还没回来的 LLM 点评（避免串组覆盖）
    stats.total += 1;
    if (r.lastRep.good) stats.good += 1;
    for (const cue of r.lastRep.cues) {
      stats.cueCounts[cue] = (stats.cueCounts[cue] ?? 0) + 1;
    }
    if (r.lastRep.metric != null) stats.metrics.push(r.lastRep.metric);

    const fb = repFeedback(r.lastRep);
    setFeedback(fb.text, fb.good);
    appendLog(fb.text, fb.good);
    el.summary.textContent = setSummary({
      exercise: exercise.name,
      total: stats.total,
      goodCount: stats.good,
    });

    // 语音：每次播计数（引擎忙就跳过，不积压）；有纠错再播提示（同一条短时间内不重复）
    speaker.speak(String(r.lastRep.index), { skippable: true });
    if (!r.lastRep.good) {
      speaker.speak(cueSpeechText(r.lastRep.cues), {
        dedupeKey: r.lastRep.cues.join(","),
      });
    }
  }
}

// ============ UI 小工具 ============
function applyExerciseToUI() {
  el.exerciseName.textContent = exercise.name;
  el.metricLabel.textContent = exercise.metricLabel;
  muscleView.highlight(exercise.muscleGroups, 0);
}

function updateSpeechBtn() {
  speechBtn.textContent = speaker.isEnabled() ? "🔊 语音开" : "🔇 语音关";
}

function setFeedback(text, good) {
  el.feedbackNow.textContent = text;
  el.feedbackNow.classList.remove("good", "warn");
  if (good === true) el.feedbackNow.classList.add("good");
  else if (good === false) el.feedbackNow.classList.add("warn");
}

function appendLog(text, good) {
  const li = document.createElement("li");
  li.textContent = text;
  li.className = good ? "good" : "warn";
  el.feedbackLog.prepend(li);
}

function setHint(text, hidden = false) {
  hint.textContent = text;
  hint.classList.toggle("hidden", hidden || !text);
}

function describeError(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "摄像头未授权：请点地址栏左侧的摄像头图标允许访问，然后重试。";
    case "NotFoundError":
    case "OverconstrainedError":
      return "没有检测到可用的摄像头设备。";
    case "NotReadableError":
    case "AbortError":
      return "摄像头被占用或无法读取：请关闭正在使用摄像头的程序（会议软件、其他浏览器标签页）后重试。";
    default:
      return explainError(err); // 处理 Event / 非 Error 对象，不再出现 "[object Event]"
  }
}

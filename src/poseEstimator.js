/**
 * 姿态估计封装：基于 Google MediaPipe Pose Landmarker（BlazePose，33 关键点）。
 * 这是项目「看得见动作」的核心，完全在浏览器本地运行、免费、不需要独显。
 *
 * 官方 Web 指南：
 * https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js
 *
 * 资源加载说明（离线版）：
 *   - WASM 运行时与模型权重（.task）已随项目放在 public/ 下，由 Vite 以本地路径提供，
 *     运行时不再访问 jsdelivr / storage.googleapis.com，教室断网或访问不了境外 CDN 也能用。
 *       public/mediapipe-wasm/  ← 来自 @mediapipe/tasks-vision@0.10.35 的 wasm/ 目录
 *       public/models/pose_landmarker_lite.task  ← 官方 lite 姿态模型（float16）
 *   - package.json 把 @mediapipe/tasks-vision 锁死为精确版本 0.10.35（不带 ^）。
 *     升级版本时，要同步替换 public/mediapipe-wasm/ 里的文件
 *     （直接从 node_modules/@mediapipe/tasks-vision/wasm/ 复制即可），否则 JS 与 WASM 版本不匹配。
 *
 * 推理后端：先试 GPU（WebGL2），失败自动回退 CPU（WASM），用的是哪种会返回给界面显示。
 */
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Vite 的 base 路径（默认 "/"），这样 build 到子目录部署时路径也正确。
const BASE = import.meta.env.BASE_URL;

// MediaPipe 的 WASM 运行时（版本与 package.json 里的 @mediapipe/tasks-vision 0.10.35 对齐）。
// 原在线地址：https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm
const WASM_PATH = `${BASE}mediapipe-wasm`;

// 姿态模型：lite 版最轻最快，无独显也能实时。
// 原在线地址：https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
// 想更高精度可下载 .../pose_landmarker_full/float16/1/pose_landmarker_full.task 放进 public/models/ 再改这里。
const MODEL_URL = `${BASE}models/pose_landmarker_lite.task`;

/** 带中文说明的初始化错误，界面直接显示 message。 */
export class PoseInitError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PoseInitError";
    this.cause = cause;
  }
}

/** 浏览器是否支持 WebGL2（MediaPipe 的 GPU 后端需要它）。 */
export function hasWebGL2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * 预检一个本地资源：能连上、HTTP 200、且不是被当成网页返回（缺文件时有的服务器会回 index.html）。
 * 只读响应头，拿到后立即取消下载，不浪费流量。
 */
async function checkAsset(url, label) {
  const ctrl = new AbortController();
  let res;
  try {
    res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } catch (e) {
    throw new PoseInitError(
      `${label}加载失败：${url}，连接不上本地服务器（开发服务器可能已关闭，请重新运行 npm run dev 后刷新页面）`,
      e,
    );
  }
  ctrl.abort();
  if (!res.ok) {
    throw new PoseInitError(`${label}加载失败：${url}，HTTP ${res.status}`);
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/html")) {
    throw new PoseInitError(
      `${label}缺失：${url}，服务器返回的是网页而不是文件（请确认 public/ 下文件完整）`,
    );
  }
}

async function createLandmarker(vision, delegate) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numPoses: 1, // 单人即可，省算力
  });
}

/**
 * 创建并初始化姿态估计器。
 * @returns {Promise<{detect: (video: HTMLVideoElement, timestampMs: number) => any,
 *                    close: () => void, delegate: "GPU"|"CPU", note: string}>}
 */
export async function createPoseEstimator() {
  // 0) 预检本地资源，出问题时给出具体 URL 和 HTTP 状态码
  await checkAsset(`${WASM_PATH}/vision_wasm_internal.js`, "WASM 运行时脚本");
  await checkAsset(`${WASM_PATH}/vision_wasm_internal.wasm`, "WASM 运行时");
  await checkAsset(MODEL_URL, "姿态模型文件");

  // 1) 加载 WASM 运行时
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

  // 2) 用 VIDEO 模式创建 Pose Landmarker：先 GPU，失败回退 CPU
  let landmarker;
  let delegate = "GPU";
  let note = "";
  if (!hasWebGL2()) {
    delegate = "CPU";
    note = "浏览器不支持 WebGL2，已直接使用 CPU 推理";
  } else {
    try {
      landmarker = await createLandmarker(vision, "GPU");
    } catch (gpuErr) {
      console.warn("[pose] GPU 后端初始化失败，回退 CPU：", gpuErr);
      delegate = "CPU";
      note = `GPU 初始化失败（${explainError(gpuErr)}），已自动回退 CPU 推理`;
    }
  }
  if (!landmarker) {
    try {
      landmarker = await createLandmarker(vision, "CPU");
    } catch (cpuErr) {
      throw new PoseInitError(`姿态模型初始化失败（CPU 后端）：${explainError(cpuErr)}`, cpuErr);
    }
  }

  return {
    delegate,
    note,
    /**
     * 对当前视频帧做一次姿态检测。
     * @param video 已经在播放的 <video> 元素
     * @param timestampMs 单调递增的时间戳（毫秒），同一帧只能用一次递增值
     * @returns MediaPipe 结果：result.landmarks[0] 是 33 个归一化关键点
     */
    detect(video, timestampMs) {
      return landmarker.detectForVideo(video, timestampMs);
    },
    close() {
      landmarker.close();
    },
  };
}

/**
 * 把任意异常（Error / DOM Event / 字符串 / 其他对象）转成人能看懂的中文说明。
 * MediaPipe 在 <script> 或资源加载失败时 reject 的是一个 Event 对象，直接 String() 会得到 "[object Event]"。
 */
export function explainError(err) {
  if (err == null) return "未知错误";
  if (typeof err === "string") return err;
  if (typeof Event !== "undefined" && err instanceof Event) {
    const t = err.target;
    const url = t?.src || t?.href || t?.url || "";
    if (err.type === "error" && url) {
      return `资源加载失败：${url}（开发服务器是否仍在运行？文件是否存在？）`;
    }
    if (err instanceof ErrorEvent && err.message) return err.message;
    return `浏览器事件 "${err.type}"${url ? `：${url}` : ""}（常见原因：WASM/模型文件加载失败或版本不匹配）`;
  }
  if (err instanceof Error) {
    const msg = err.message || err.name;
    if (/webgl|gl context|emscripten_webgl/i.test(msg)) return `浏览器 WebGL 不可用：${msg}`;
    return msg;
  }
  try {
    const s = JSON.stringify(err);
    if (s && s !== "{}") return s;
  } catch {
    /* ignore */
  }
  return Object.prototype.toString.call(err);
}

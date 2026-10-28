/**
 * poseEngine.js —— 在 file:// 下也能用的 MediaPipe Pose Landmarker 加载器（离线网页版专用）。
 *
 * 开发版（src/poseEstimator.js）靠 Vite 服务器按 URL 加载 WASM 和模型；双击打开的
 * file:// 页面不能 fetch 本地文件，所以这里换了三件事（都不改第三方文件本身）：
 *   1. WASM 运行时的胶水脚本 engine/vision_wasm_internal.js 用普通 <script> 加载，
 *      它会定义全局 ModuleFactory；我们先把它存到 window.__MP_MODULE_FACTORY。
 *      MediaPipe 自己加载胶水脚本时会加 crossOrigin，file:// 下会被拦，所以给它一个
 *      data: 小脚本，内容只是把存好的 ModuleFactory 放回去。
 *   2. WASM 二进制（约 11 MB）由 engine/wasm_b64.js 以 base64 字符串提供，解码后做成 Blob URL。
 *   3. 模型 pose_landmarker_lite.task（约 5.8 MB）由 engine/model_b64.js 提供，
 *      解码后用 modelAssetBuffer 直接交给 MediaPipe。
 * 这三个文件合计约 22 MB，只在第一次进入「我来练」时才加载，「看示例」不需要它们。
 */
import { PoseLandmarker } from "@mediapipe/tasks-vision";

const ENGINE_DIR = "engine/";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`脚本加载失败：${src}（请确认解压后 play/engine/ 文件夹完整）`));
    document.head.appendChild(s);
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 浏览器是否支持 WASM SIMD（MediaPipe 这一版只带了 SIMD 版运行时）。 */
export function hasWasmSimd() {
  try {
    // 最小的含 SIMD 指令的模块（v128.const + i8x16.popcnt），能通过校验说明支持
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}

let fileset = null; // 只解码一次，之后重复使用
let modelBytes = null;

/**
 * 加载引擎文件并创建姿态估计器（先试 GPU，失败回退 CPU）。
 * @param {(msg:string)=>void} onStatus 进度提示
 */
export async function createPoseEngine(onStatus = () => {}) {
  if (!hasWasmSimd()) {
    throw new Error("这个浏览器不支持 WebAssembly SIMD，姿态引擎无法运行。请换用较新版本的 Edge / Chrome / Safari。");
  }
  if (!fileset) {
    onStatus("正在加载姿态引擎（约 22 MB，只在第一次需要几秒）…");
    await loadScript(ENGINE_DIR + "vision_wasm_internal.js");
    window.__MP_MODULE_FACTORY = self.ModuleFactory;
    await loadScript(ENGINE_DIR + "wasm_b64.js");
    await loadScript(ENGINE_DIR + "model_b64.js");
    if (!window.__MP_WASM_B64 || !window.__MP_MODEL_B64) throw new Error("引擎数据文件不完整（engine/wasm_b64.js 或 model_b64.js）。");
    onStatus("正在解码模型…");
    const wasm = b64ToBytes(window.__MP_WASM_B64);
    modelBytes = b64ToBytes(window.__MP_MODEL_B64);
    // 解码后立刻释放 base64 大字符串
    window.__MP_WASM_B64 = null;
    window.__MP_MODEL_B64 = null;
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    const shim = "data:text/javascript," + encodeURIComponent("self.ModuleFactory=window.__MP_MODULE_FACTORY;");
    fileset = { wasmLoaderPath: shim, wasmBinaryPath: wasmUrl };
  }

  const make = (delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });

  onStatus("正在初始化姿态模型…");
  let landmarker = null;
  let delegate = "GPU";
  let note = "";
  try {
    landmarker = await make("GPU");
  } catch (e) {
    console.warn("[pose] GPU 后端初始化失败，回退 CPU：", e);
    delegate = "CPU";
    note = "GPU 不可用，已改用 CPU";
    landmarker = await make("CPU");
  }
  return {
    delegate,
    note,
    detect: (video, ts) => landmarker.detectForVideo(video, ts),
    close: () => {
      try {
        landmarker.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 退出时释放解码后的大数组。 */
export function releaseEngineData() {
  if (fileset) URL.revokeObjectURL(fileset.wasmBinaryPath);
  fileset = null;
  modelBytes = null;
  window.__MP_MODULE_FACTORY = null;
}

/** 33 个关键点之间的连线（来自 MediaPipe 官方定义）。 */
export const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

// build_play.mjs —— 生成离线网页包 play/（双击 play/index.html 即可用，也直接作为 GitHub Pages）。
//
//   node tools/build_play.mjs            构建 play/
//   （一条命令完整构建 + 打 zip：python tools/build.py --release）
//
// 做的事：
//   1. 用 Vite（库模式，IIFE 格式）把 play_src/app.js 连同 src/ 里的规则模块、
//      @mediapipe/tasks-vision、body-muscles 打成一个普通脚本 play/app.js（file:// 下不能用 type="module"）。
//   2. 复制 play_src/index.html、style.css。
//   3. 姿态引擎：WASM 胶水脚本原样复制；WASM 二进制和模型 .task 转成 base64 写进 .js
//      （file:// 下不能 fetch 本地文件，只能用 <script> 加载）。只用 SIMD 版运行时。
//   4. credits.json → play/credits.js（页脚署名）。
//   5. 写 results/build_info.json：每个产物的大小和来源文件 md5（README 里的体积数字以它为准）。
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "play");
const ENGINE = path.join(OUT, "engine");
const WASM_DIR = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const MODEL = path.join(ROOT, "public", "models", "pose_landmarker_lite.task");
const creditsPath = process.argv.includes("--credits")
  ? path.resolve(process.argv[process.argv.indexOf("--credits") + 1])
  : path.join(ROOT, "credits.json");

const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function writeCredits() {
  const credits = JSON.parse(fs.readFileSync(creditsPath, "utf8"));
  fs.writeFileSync(
    path.join(OUT, "credits.js"),
    "// 由 credits.json 生成（tools/build_play.mjs / tools/fill_credits.py），请勿手改。\n" +
      `window.CREDITS = ${JSON.stringify(credits, null, 2)};\n`,
  );
}

function writeNotices() {
  const credits = JSON.parse(fs.readFileSync(creditsPath, "utf8"));
  // 公开仓库里在 LICENSES/，内部开发目录里在 publish_templates/LICENSES/
  const licDir = [path.join(ROOT, "LICENSES"), path.join(ROOT, "publish_templates", "LICENSES")].find((d) => fs.existsSync(d));
  const lic = (f) => fs.readFileSync(path.join(licDir, f), "utf8");
  const text = [
    "THIRD-PARTY NOTICES / 第三方许可证声明",
    "=====================================",
    "",
    `本页面（play/）的代码：MIT License，Copyright (c) ${credits.YEAR} ${credits.AUTHOR}。完整条款见仓库根目录 LICENSE。`,
    "页面里的说明文字：CC BY 4.0，完整条款见仓库根目录 LICENSE-docs。",
    "",
    "本目录还包含以下第三方组件（均未修改，只是打包或转成 base64）：",
    "",
    "1. MediaPipe Tasks Vision 0.10.35（@mediapipe/tasks-vision，Google）— Apache License 2.0",
    "   - app.js 内含其 JavaScript 代码；engine/vision_wasm_internal.js 为其 WASM 胶水脚本；",
    "   - engine/wasm_b64.js 为其 vision_wasm_internal.wasm 的 base64 编码。",
    "2. Pose Landmarker (Lite) 模型 pose_landmarker_lite.task（Google MediaPipe，BlazePose GHUM 3D）— Apache License 2.0",
    "   - engine/model_b64.js 为其 base64 编码。来源：storage.googleapis.com/mediapipe-models/pose_landmarker/",
    "3. body-muscles 1.0.0（Ivan Vulović）— Apache License 2.0；app.js 内含其代码与 SVG 数据。其 NOTICE 原文如下：",
    "",
    lic("body-muscles-NOTICE.txt").trim(),
    "",
    "-------------------------------------------------------------------------------",
    "Apache License 2.0 全文：",
    "-------------------------------------------------------------------------------",
    lic("Apache-2.0.txt"),
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "THIRD_PARTY_NOTICES.txt"), text);
}

async function main() {
  fs.mkdirSync(ENGINE, { recursive: true });

  // 1) 打包 app.js
  await build({
    configFile: false,
    root: ROOT,
    publicDir: false, // 不要把 public/（开发版的 21 MB WASM）复制进来
    logLevel: "warn",
    build: {
      outDir: OUT,
      emptyOutDir: false,
      minify: false, // 保持可读，方便同学打开看
      sourcemap: false,
      target: "es2020",
      lib: {
        entry: path.join(ROOT, "play_src", "app.js"),
        formats: ["iife"],
        name: "PoseCoachApp",
        fileName: () => "app.js",
      },
    },
  });

  // 2) 页面与样式
  for (const f of ["index.html", "style.css"]) fs.copyFileSync(path.join(ROOT, "play_src", f), path.join(OUT, f));

  // 3) 引擎文件
  const loader = fs.readFileSync(path.join(WASM_DIR, "vision_wasm_internal.js"));
  fs.writeFileSync(path.join(ENGINE, "vision_wasm_internal.js"), loader);
  const wasm = fs.readFileSync(path.join(WASM_DIR, "vision_wasm_internal.wasm"));
  const model = fs.readFileSync(MODEL);
  const header = (what, buf) =>
    `// ${what}，base64 编码（file:// 下网页不能 fetch 本地文件，只能这样用 <script> 加载）。\n` +
    `// 原始文件 ${buf.length} 字节，md5 ${md5(buf)}。由 tools/build_play.mjs 生成。\n`;
  fs.writeFileSync(
    path.join(ENGINE, "wasm_b64.js"),
    header("MediaPipe tasks-vision 0.10.35 的 vision_wasm_internal.wasm（Apache-2.0）", wasm) +
      `window.__MP_WASM_B64="${wasm.toString("base64")}";\n`,
  );
  fs.writeFileSync(
    path.join(ENGINE, "model_b64.js"),
    header("MediaPipe 官方模型 pose_landmarker_lite.task（float16，Apache-2.0）", model) +
      `window.__MP_MODEL_B64="${model.toString("base64")}";\n`,
  );

  // 4) 署名 + 随包分发的许可证声明（Release zip 只含 play/，所以声明要放在 play/ 里）
  writeCredits();
  writeNotices();

  // 5) 构建信息
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push({ path: rel(p), bytes: fs.statSync(p).size });
    }
  };
  walk(OUT);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "package.json"), "utf8"));
  const info = {
    generated_by: "tools/build_play.mjs",
    tasks_vision_version: pkg.version,
    sources: {
      wasm: { file: "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", bytes: wasm.length, md5: md5(wasm) },
      model: { file: "public/models/pose_landmarker_lite.task", bytes: model.length, md5: md5(model) },
    },
    play_files: files,
    play_total_bytes: files.reduce((a, f) => a + f.bytes, 0),
  };
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  const infoPath = path.join(ROOT, "results", "build_info.json");
  // 若 build.py 之后会补上 zip 信息，这里保留已有的 release 字段
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  } catch {
    /* 第一次构建 */
  }
  fs.writeFileSync(infoPath, JSON.stringify({ ...info, release: old.release ?? null }, null, 2) + "\n");
  console.log(`play/ 构建完成：${files.length} 个文件，共 ${(info.play_total_bytes / 1e6).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

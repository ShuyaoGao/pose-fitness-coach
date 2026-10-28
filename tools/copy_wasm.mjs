// copy_wasm.mjs —— 开发版（npm run dev）需要的 MediaPipe WASM 运行时：从 node_modules 复制到 public/mediapipe-wasm/。
// 这些文件约 21 MB，不进仓库（.gitignore）；npm install 之后由 npm run dev / npm run build 自动调用。
// 离线网页版 play/ 不用它们（见 tools/build_play.mjs）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const DST = path.join(ROOT, "public", "mediapipe-wasm");
fs.mkdirSync(DST, { recursive: true });
for (const f of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  const src = path.join(SRC, f);
  const dst = path.join(DST, f);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}
console.log("public/mediapipe-wasm/ 已就绪");

# 第三方组件与许可证

本仓库自己的代码使用 MIT（[LICENSE](LICENSE)），文档和教学素材使用 CC BY 4.0（[LICENSE-docs](LICENSE-docs)）。
以下第三方组件随仓库或网页包一起分发，**都没有修改**，只是打包进 `play/app.js` 或转成 base64。
网页包 `play/` 里另有一份 [`play/THIRD_PARTY_NOTICES.txt`](play/THIRD_PARTY_NOTICES.txt)，Release zip 只含 play/ 时也能看到这些声明。

| 组件 | 版本 | 许可证 | 在本仓库中的位置 | 来源 |
|---|---|---|---|---|
| MediaPipe Tasks Vision（`@mediapipe/tasks-vision`，Google） | 0.10.35 | Apache-2.0 | `play/app.js`（打包的 JS）、`play/engine/vision_wasm_internal.js`、`play/engine/wasm_b64.js`（WASM 的 base64） | npm；WASM 与 npm 包 `wasm/` 目录逐字节一致 |
| Pose Landmarker (Lite) 模型 `pose_landmarker_lite.task`（Google MediaPipe，BlazePose GHUM 3D） | float16 / 1 | Apache-2.0（见官方模型卡） | `public/models/pose_landmarker_lite.task`、`play/engine/model_b64.js` | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`，5,777,746 字节，md5 与官方文件一致（`04a75ddf7c811ac7a1a4523266dd7d88`） |
| body-muscles（Ivan Vulović） | 1.0.0 | Apache-2.0 | `play/app.js`（打包的 JS 与 SVG 数据） | npm；NOTICE 见 [LICENSES/body-muscles-NOTICE.txt](LICENSES/body-muscles-NOTICE.txt) |
| Vite | 8.0.14 | MIT | 只在开发和构建时使用，不随网页分发（打包产物里可能含少量构建工具的运行时辅助代码） | npm |

Apache License 2.0 全文：[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)。body-muscles 自带的 LICENSE 原文：[LICENSES/body-muscles-LICENSE.txt](LICENSES/body-muscles-LICENSE.txt)。

模型卡（BlazePose GHUM 3D）注明的预期用途包括 “Fitness and repetition counting”；明确排除任何形式的监控和身份识别。本项目只用于课堂演示。

## 不随仓库分发、只在本机可选使用的软件

| 软件 | 许可证 | 用途 |
|---|---|---|
| Ollama | MIT | 可选的本机大模型服务，默认关闭 |
| Qwen3（`qwen3:4b`，阿里通义） | Apache-2.0 | 可选的组总结润色模型，需用户自己下载 |
| 浏览器 Web Speech API | — | 语音播报（默认关闭），使用操作系统自带语音 |

## 字体、图片、音效

- 不内嵌任何字体，页面使用操作系统自带字体。
- 没有使用外部图片或音效。肌肉图来自 body-muscles 的 SVG；示例骨架动作由 `play_src/replayGen.js` 程序生成，不是真人录制。
- `docs/img/` 中的截图由 `tools/browser_check.py` 和 `tools/mobile_check_pfc.py` 自动截取，属于本仓库的文档素材（CC BY 4.0）。

## 代码来源

除上表所列组件外，本仓库代码为本项目原创；MediaPipe 的调用方式参照其官方文档的公开 API。
没有从其他项目复制代码。文中提到的 MediaPipe、BlazePose、Ollama、Qwen、Edge、Chrome、Safari 等名称仅用于说明来源和兼容性，归各自权利人所有。

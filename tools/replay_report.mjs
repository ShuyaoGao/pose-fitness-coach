// replay_report.mjs —— 把每段合成示例在每个严格度档位下跑一遍规则引擎，结果写进 results/result.json。
// README 和页面说明里提到的次数 / 判定 / 最低膝角等数字都以这个文件为准。
//
//   node tools/replay_report.mjs
//
// 规则和合成数据都是确定的（固定随机种子），重复运行结果逐字节相同。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIPS, FPS, generateClip } from "../play_src/replayGen.js";
import { thresholdsFor, PRESET_LABELS } from "../play_src/presets.js";
import { createSquatExercise } from "../src/exercises/squat.js";
import { createJumpingJackExercise } from "../src/exercises/jumpingJack.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runClip(id, preset) {
  const clip = generateClip(id);
  const kind = clip.meta.exercise;
  const T = thresholdsFor(kind, preset);
  const ex = kind === "squat" ? createSquatExercise(T) : createJumpingJackExercise(T);
  const reps = [];
  let notReadyFrames = 0;
  for (const f of clip.frames) {
    const r = ex.update(f);
    if (!r.ready) notReadyFrames++;
    if (r.repCompleted) reps.push(r.lastRep);
  }
  const cueCounts = {};
  for (const r of reps) for (const c of r.cues) cueCounts[c] = (cueCounts[c] ?? 0) + 1;
  return {
    count: reps.length,
    good: reps.filter((r) => r.good).length,
    cue_counts: cueCounts,
    not_ready_frames: notReadyFrames,
    reps: reps.map((r) =>
      kind === "squat"
        ? { min_knee_angle: r.minKneeAngle, min_valgus_ratio: r.minValgusRatio, cues: r.cues }
        : { max_spread: r.maxSpread, arms_up: r.armsUp, cues: r.cues },
    ),
  };
}

export function buildReport() {
  const out = {
    generated_by: "tools/replay_report.mjs",
    note: "示例动作由 play_src/replayGen.js 程序合成（不是真人录制），规则来自 src/exercises/*.js。",
    fps: FPS,
    presets: {},
    clips: {},
  };
  for (const kind of ["squat", "jumpingJack"]) {
    out.presets[kind] = {};
    for (const p of ["loose", "standard", "strict"]) out.presets[kind][p] = { label: PRESET_LABELS[p], thresholds: thresholdsFor(kind, p) };
  }
  for (const c of CLIPS) {
    const clip = generateClip(c.id);
    out.clips[c.id] = {
      name: c.name,
      exercise: c.exercise,
      frames: clip.frames.length,
      seconds: Number(((clip.frames.length - 1) / FPS).toFixed(2)),
      by_preset: Object.fromEntries(["loose", "standard", "strict"].map((p) => [p, runClip(c.id, p)])),
    };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rep = buildReport();
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "result.json"), JSON.stringify(rep, null, 2) + "\n");
  for (const [id, c] of Object.entries(rep.clips)) {
    const s = Object.entries(c.by_preset).map(([p, r]) => `${p}:${r.good}/${r.count}`).join("  ");
    console.log(`${id.padEnd(14)} ${s}`);
  }
  console.log("已写 results/result.json");
}

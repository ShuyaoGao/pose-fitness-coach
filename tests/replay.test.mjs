/**
 * 合成示例片段的自测（不需要浏览器）：
 *   1) 生成是确定的（两次生成逐帧相同）；
 *   2) 每段在「标准」档下的次数和判定符合片段说明；
 *   3) 换档位后判定按说明改变（页面上「试试把严格度换成……」的说法要成立）；
 *   4) results/result.json 与当前代码重新计算的结果一致（README 引用的数字没有过期）。
 *
 * 运行： node tests/replay.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIPS, buildClip, getClipMeta } from "../play_src/replayGen.js";
import { runClip, buildReport } from "../tools/replay_report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

console.log("测试 1：生成确定");
for (const c of CLIPS) {
  const a = JSON.stringify(buildClip(getClipMeta(c.id)).frames);
  const b = JSON.stringify(buildClip(getClipMeta(c.id)).frames);
  check(`${c.id} 两次生成相同`, a === b);
}
check("33 个关键点 / 帧", buildClip(CLIPS[0]).frames.every((f) => f.length === 33));

console.log("\n测试 2：标准档");
const std = (id) => runClip(id, "standard");
check("深蹲·标准：5 次全部标准", std("squat_good").count === 5 && std("squat_good").good === 5);
check("深蹲·蹲太浅：4 次全报不够深", std("squat_shallow").count === 4 && std("squat_shallow").cue_counts.shallow === 4);
check("深蹲·膝内扣：4 次全报内扣、不报不够深",
  std("squat_valgus").count === 4 && std("squat_valgus").cue_counts.valgus === 4 && !std("squat_valgus").cue_counts.shallow);
check("深蹲·脚出画面：0 次、每帧都不可判定",
  std("squat_cropped").count === 0 && std("squat_cropped").not_ready_frames === buildClip(getClipMeta("squat_cropped")).frames.length);
check("开合跳·标准：6 次全部标准", std("jj_good").count === 6 && std("jj_good").good === 6);
check("开合跳·手没举：5 次全报 arms_low、不报 narrow",
  std("jj_arms_low").count === 5 && std("jj_arms_low").cue_counts.arms_low === 5 && !std("jj_arms_low").cue_counts.narrow);
check("开合跳·腿没开：5 次全报 narrow、不报 arms_low",
  std("jj_narrow").count === 5 && std("jj_narrow").cue_counts.narrow === 5 && !std("jj_narrow").cue_counts.arms_low);

console.log("\n测试 3：换档位后的变化（与片段说明一致）");
check("深蹲·标准 → 严格档：每次都报不够深", runClip("squat_good", "strict").cue_counts.shallow === 5);
check("深蹲·蹲太浅 → 宽松档：全部通过", runClip("squat_shallow", "loose").good === 4);
check("深蹲·膝内扣 → 宽松档：全部通过", runClip("squat_valgus", "loose").good === 4);
check("开合跳·标准 → 严格档：每次都报张开不足", runClip("jj_good", "strict").cue_counts.narrow === 6);
check("开合跳·腿没开 → 宽松档：全部通过", runClip("jj_narrow", "loose").good === 5);
check("开合跳·手没举 → 宽松档：仍然报 arms_low（这条没有阈值）", runClip("jj_arms_low", "loose").cue_counts.arms_low === 5);
for (const p of ["loose", "standard", "strict"]) {
  check(`换档不改变计数（${p}）`, CLIPS.every((c) => runClip(c.id, p).count === std(c.id).count));
}

console.log("\n测试 4：results/result.json 没有过期");
{
  const file = path.join(ROOT, "results", "result.json");
  const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  check("与重新计算的结果一致（不一致请运行 node tools/replay_report.mjs）", onDisk === JSON.stringify(buildReport(), null, 2) + "\n");
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

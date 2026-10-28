/**
 * 阈值可传参的自测（不需要浏览器/摄像头）：
 *   1) 默认阈值与改动前的常量完全一致；
 *   2) 不传参数时行为不变（与 squat.test.mjs / jumpingJack.test.mjs 互相印证）；
 *   3) 传入覆盖值后，同一组关键点的判定随之改变；
 *   4) 实例上暴露的 thresholds / required 正确。
 *
 * 运行： node tests/thresholds.test.mjs
 */
import { createSquatExercise, SQUAT_DEFAULTS } from "../src/exercises/squat.js";
import { createJumpingJackExercise, JUMPING_JACK_DEFAULTS } from "../src/exercises/jumpingJack.js";
import { POSE } from "../src/landmarks.js";

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

function legs({ lh, rh, lk, rk, la, ra }) {
  const arr = new Array(33).fill(null);
  const p = (pt) => ({ x: pt.x, y: pt.y, z: 0, visibility: 1 });
  arr[POSE.LEFT_HIP] = p(lh);
  arr[POSE.RIGHT_HIP] = p(rh);
  arr[POSE.LEFT_KNEE] = p(lk);
  arr[POSE.RIGHT_KNEE] = p(rk);
  arr[POSE.LEFT_ANKLE] = p(la);
  arr[POSE.RIGHT_ANKLE] = p(ra);
  return arr;
}
const STAND = legs({
  lh: { x: 0.46, y: 0.45 }, rh: { x: 0.54, y: 0.45 },
  lk: { x: 0.46, y: 0.62 }, rk: { x: 0.54, y: 0.62 },
  la: { x: 0.46, y: 0.82 }, ra: { x: 0.54, y: 0.82 },
});
const SHALLOW = legs({
  lh: { x: 0.47, y: 0.60 }, rh: { x: 0.53, y: 0.60 },
  lk: { x: 0.41, y: 0.65 }, rk: { x: 0.59, y: 0.65 },
  la: { x: 0.45, y: 0.82 }, ra: { x: 0.55, y: 0.82 },
});

console.log("测试 1：默认阈值等于原来的常量");
check("深蹲默认值", JSON.stringify(SQUAT_DEFAULTS) ===
  JSON.stringify({ standAngle: 170, deepTarget: 90, upAngle: 160, downAngle: 130, shallowAngle: 105, valgusRatio: 0.55 }));
check("开合跳默认值", JSON.stringify(JUMPING_JACK_DEFAULTS) ===
  JSON.stringify({ openRatio: 1.3, closeRatio: 1.0, fullSpread: 1.6, spreadRest: 0.6, spreadMax: 1.9 }));
check("默认值不可被修改（冻结）", Object.isFrozen(SQUAT_DEFAULTS) && Object.isFrozen(JUMPING_JACK_DEFAULTS));

console.log("\n测试 2：实例暴露 thresholds / required");
{
  const a = createSquatExercise();
  const b = createSquatExercise({ shallowAngle: 120 });
  check("不传参 = 默认值", a.thresholds.shallowAngle === 105 && a.thresholds.upAngle === 160);
  check("覆盖一项，其余保持默认", b.thresholds.shallowAngle === 120 && b.thresholds.valgusRatio === 0.55);
  check("深蹲 required = 髋膝踝 6 点", JSON.stringify(a.required) === JSON.stringify([23, 24, 25, 26, 27, 28]));
  const j = createJumpingJackExercise();
  check("开合跳 required = 鼻肩腕踝 7 点", JSON.stringify(j.required) === JSON.stringify([0, 11, 12, 15, 16, 27, 28]));
}

console.log("\n测试 3：同一组浅蹲，阈值放宽后不再报「不够深」");
{
  const run = (opts) => {
    const ex = createSquatExercise(opts);
    ex.update(STAND);
    ex.update(SHALLOW);
    return ex.update(STAND);
  };
  const def = run();
  const loose = run({ shallowAngle: 130 });
  check("默认：报 shallow", def.lastRep?.cues.includes("shallow"));
  check("shallowAngle=130：不报 shallow", loose.lastRep && !loose.lastRep.cues.includes("shallow"));
  const noCount = run({ downAngle: 100 });
  check("downAngle=100：浅蹲连「下蹲」都进不去，不计数", noCount.count === 0);
}

console.log("\n测试 4：开合跳 fullSpread 覆盖");
{
  const frame = (spreadHalf, armsUp) => {
    const arr = new Array(33).fill(null);
    const p = (x, y) => ({ x, y, z: 0, visibility: 1 });
    arr[POSE.NOSE] = p(0.5, 0.2);
    arr[POSE.LEFT_SHOULDER] = p(0.45, 0.3);
    arr[POSE.RIGHT_SHOULDER] = p(0.55, 0.3);
    const wy = armsUp ? 0.1 : 0.5;
    arr[POSE.LEFT_WRIST] = p(0.4, wy);
    arr[POSE.RIGHT_WRIST] = p(0.6, wy);
    arr[POSE.LEFT_ANKLE] = p(0.5 - spreadHalf, 0.9);
    arr[POSE.RIGHT_ANKLE] = p(0.5 + spreadHalf, 0.9);
    return arr;
  };
  const run = (opts) => {
    const ex = createJumpingJackExercise(opts);
    ex.update(frame(0.03, false)); // 并拢 spread 0.6
    ex.update(frame(0.075, true)); // 张开 spread 1.5
    return ex.update(frame(0.03, false));
  };
  check("默认 1.6：张开 1.5 报 narrow", run().lastRep?.cues.includes("narrow"));
  check("fullSpread=1.45：不报 narrow", run({ fullSpread: 1.45 }).lastRep?.good === true);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

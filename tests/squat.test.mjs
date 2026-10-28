/**
 * 深蹲状态机的纯逻辑自测（不需要浏览器/摄像头）。
 * 用「人造关键点」模拟站立↔下蹲的序列，验证：
 *   1) 计数不漏不重（10 次 = 10）；
 *   2) 标准深蹲不报错；
 *   3) 蹲太浅触发 shallow 提示；
 *   4) 膝盖内扣触发 valgus 提示；
 *   5) 关键点不可见时 ready=false、不计数。
 *
 * 运行： node tests/squat.test.mjs
 */
import { createSquatExercise } from "../src/exercises/squat.js";
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

/** 用 6 个关键点（髋/膝/踝 左右）构造一帧 landmarks（其余点不影响判定）。 */
function frame({ lh, rh, lk, rk, la, ra }, visibility = 1) {
  const arr = new Array(33).fill(null);
  const p = (pt) => ({ x: pt.x, y: pt.y, z: 0, visibility });
  arr[POSE.LEFT_HIP] = p(lh);
  arr[POSE.RIGHT_HIP] = p(rh);
  arr[POSE.LEFT_KNEE] = p(lk);
  arr[POSE.RIGHT_KNEE] = p(rk);
  arr[POSE.LEFT_ANKLE] = p(la);
  arr[POSE.RIGHT_ANKLE] = p(ra);
  return arr;
}

// ---- 典型姿势帧 ----
const STAND = frame({
  lh: { x: 0.46, y: 0.45 }, rh: { x: 0.54, y: 0.45 },
  lk: { x: 0.46, y: 0.62 }, rk: { x: 0.54, y: 0.62 },
  la: { x: 0.46, y: 0.82 }, ra: { x: 0.54, y: 0.82 },
}); // 双腿竖直 → 膝角 ~180°

const DEEP_GOOD = frame({
  lh: { x: 0.48, y: 0.62 }, rh: { x: 0.52, y: 0.62 },
  lk: { x: 0.38, y: 0.66 }, rk: { x: 0.62, y: 0.66 },
  la: { x: 0.45, y: 0.82 }, ra: { x: 0.55, y: 0.82 },
}); // 蹲深、膝盖外展对齐脚尖 → 角度小、无内扣

const SHALLOW = frame({
  lh: { x: 0.47, y: 0.60 }, rh: { x: 0.53, y: 0.60 },
  lk: { x: 0.41, y: 0.65 }, rk: { x: 0.59, y: 0.65 },
  la: { x: 0.45, y: 0.82 }, ra: { x: 0.55, y: 0.82 },
}); // 只蹲了一半（膝角偏大）但已越过下蹲阈值 → 应计数且报「不够深」

const VALGUS = frame({
  lh: { x: 0.44, y: 0.64 }, rh: { x: 0.56, y: 0.64 },
  lk: { x: 0.49, y: 0.68 }, rk: { x: 0.51, y: 0.68 },
  la: { x: 0.41, y: 0.82 }, ra: { x: 0.59, y: 0.82 },
}); // 蹲得够深，但两膝内扣（膝间距 << 踝间距）→ 应报「膝盖内扣」

// 打印一下三种底部姿势实际算出的膝角/内扣比，便于核对阈值
function peek(label, f) {
  const e = createSquatExercise();
  const r = e.update(f);
  console.log(`    [${label}] 膝角=${r.kneeAngle}°  depthRatio=${r.depthRatio.toFixed(2)}`);
}

console.log("各底部姿势的实际测量值：");
peek("DEEP_GOOD", DEEP_GOOD);
peek("SHALLOW  ", SHALLOW);
peek("VALGUS   ", VALGUS);

// ---- 测试 1：10 次标准深蹲，计数应为 10，且全部 good ----
console.log("\n测试 1：连续 10 次标准深蹲");
{
  const ex = createSquatExercise();
  ex.update(STAND); // 初始化为「站立」
  let goodReps = 0;
  for (let i = 0; i < 10; i++) {
    ex.update(DEEP_GOOD); // 下蹲
    const r = ex.update(STAND); // 站起 → 完成一次
    if (r.repCompleted && r.lastRep?.good) goodReps++;
  }
  const final = ex.update(STAND);
  check("计数等于 10（不漏不重）", final.count === 10);
  check("10 次全部判为标准", goodReps === 10);
}

// ---- 测试 2：蹲太浅 → 触发 shallow ----
console.log("\n测试 2：蹲太浅");
{
  const ex = createSquatExercise();
  ex.update(STAND);
  ex.update(SHALLOW);
  const r = ex.update(STAND);
  check("浅蹲也被计数（count=1）", r.count === 1);
  check("触发『不够深』提示(shallow)", r.lastRep?.cues.includes("shallow"));
  check("浅蹲不被判为标准", r.lastRep?.good === false);
}

// ---- 测试 3：膝盖内扣 → 触发 valgus ----
console.log("\n测试 3：膝盖内扣");
{
  const ex = createSquatExercise();
  ex.update(STAND);
  ex.update(VALGUS);
  const r = ex.update(STAND);
  check("内扣深蹲被计数（count=1）", r.count === 1);
  check("触发『膝盖内扣』提示(valgus)", r.lastRep?.cues.includes("valgus"));
}

// ---- 测试 4：关键点不可见 → ready=false 且不计数 ----
console.log("\n测试 4：关键点不可见");
{
  const ex = createSquatExercise();
  const hidden = frame(
    {
      lh: { x: 0.46, y: 0.45 }, rh: { x: 0.54, y: 0.45 },
      lk: { x: 0.46, y: 0.62 }, rk: { x: 0.54, y: 0.62 },
      la: { x: 0.46, y: 0.82 }, ra: { x: 0.54, y: 0.82 },
    },
    0.1 // 可见度很低
  );
  const r = ex.update(hidden);
  check("ready=false", r.ready === false);
  check("不计数", r.count === 0);
}

// ---- 测试 5：微微晃动（始终站立）不应误计数 ----
console.log("\n测试 5：站着轻微晃动不误计数");
{
  const ex = createSquatExercise();
  for (let i = 0; i < 20; i++) ex.update(STAND);
  const r = ex.update(STAND);
  check("count 保持 0", r.count === 0);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

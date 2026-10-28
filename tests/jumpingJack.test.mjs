/**
 * 开合跳状态机的纯逻辑自测（不需要浏览器/摄像头），风格仿照 squat.test.mjs。
 * 用「人造关键点」模拟并拢↔张开的序列，验证：
 *   1) 计数不漏不重（10 次 = 10）；
 *   2) 标准开合跳不报错；
 *   3) 只跳腿不抬臂触发 arms_low 提示；
 *   4) 腿张得不够开触发 narrow 提示；
 *   5) 关键点不可见时 ready=false、不计数；
 *   6) 并拢站立轻微晃动不误计数。
 *
 * 运行： node tests/jumpingJack.test.mjs
 */
import { createJumpingJackExercise } from "../src/exercises/jumpingJack.js";
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

/** 用 7 个关键点（鼻/肩/腕/踝）构造一帧 landmarks（其余点不影响判定）。 */
function frame({ nose, ls, rs, lw, rw, la, ra }, visibility = 1) {
  const arr = new Array(33).fill(null);
  const p = (pt) => ({ x: pt.x, y: pt.y, z: 0, visibility });
  arr[POSE.NOSE] = p(nose);
  arr[POSE.LEFT_SHOULDER] = p(ls);
  arr[POSE.RIGHT_SHOULDER] = p(rs);
  arr[POSE.LEFT_WRIST] = p(lw);
  arr[POSE.RIGHT_WRIST] = p(rw);
  arr[POSE.LEFT_ANKLE] = p(la);
  arr[POSE.RIGHT_ANKLE] = p(ra);
  return arr;
}

// ---- 典型姿势帧（肩宽固定 0.10，spread = 踝距/肩宽）----
const CLOSED = frame({
  nose: { x: 0.50, y: 0.20 },
  ls: { x: 0.45, y: 0.30 }, rs: { x: 0.55, y: 0.30 },
  lw: { x: 0.44, y: 0.55 }, rw: { x: 0.56, y: 0.55 }, // 手垂在身体两侧
  la: { x: 0.48, y: 0.85 }, ra: { x: 0.52, y: 0.85 }, // 踝距 0.04 → spread 0.4（并拢）
});

const OPEN_GOOD = frame({
  nose: { x: 0.50, y: 0.20 },
  ls: { x: 0.45, y: 0.30 }, rs: { x: 0.55, y: 0.30 },
  lw: { x: 0.46, y: 0.08 }, rw: { x: 0.54, y: 0.08 }, // 双腕高于鼻子 → 举过头顶
  la: { x: 0.40, y: 0.85 }, ra: { x: 0.60, y: 0.85 }, // 踝距 0.20 → spread 2.0（完全跳开）
});

const OPEN_ARMS_LOW = frame({
  nose: { x: 0.50, y: 0.20 },
  ls: { x: 0.45, y: 0.30 }, rs: { x: 0.55, y: 0.30 },
  lw: { x: 0.44, y: 0.55 }, rw: { x: 0.56, y: 0.55 }, // 腿跳开了，但手没抬
  la: { x: 0.40, y: 0.85 }, ra: { x: 0.60, y: 0.85 },
});

const OPEN_NARROW = frame({
  nose: { x: 0.50, y: 0.20 },
  ls: { x: 0.45, y: 0.30 }, rs: { x: 0.55, y: 0.30 },
  lw: { x: 0.46, y: 0.08 }, rw: { x: 0.54, y: 0.08 }, // 手举到位
  la: { x: 0.43, y: 0.85 }, ra: { x: 0.57, y: 0.85 }, // 踝距 0.14 → spread 1.4（>1.3 算张开，<1.6 不到位）
});

// 打印各姿势实际算出的 spread，便于核对阈值
function peek(label, f) {
  const e = createJumpingJackExercise();
  const r = e.update(f);
  console.log(`    [${label}] spread=${r.spreadRatio}  depthRatio=${r.depthRatio.toFixed(2)}`);
}

console.log("各姿势的实际测量值：");
peek("CLOSED       ", CLOSED);
peek("OPEN_GOOD    ", OPEN_GOOD);
peek("OPEN_ARMS_LOW", OPEN_ARMS_LOW);
peek("OPEN_NARROW  ", OPEN_NARROW);

// ---- 测试 1：10 次标准开合跳，计数应为 10，且全部 good ----
console.log("\n测试 1：连续 10 次标准开合跳");
{
  const ex = createJumpingJackExercise();
  ex.update(CLOSED); // 初始化为「并拢」
  let goodReps = 0;
  for (let i = 0; i < 10; i++) {
    ex.update(OPEN_GOOD); // 跳开
    const r = ex.update(CLOSED); // 跳回并拢 → 完成一次
    if (r.repCompleted && r.lastRep?.good) goodReps++;
  }
  const final = ex.update(CLOSED);
  check("计数等于 10（不漏不重）", final.count === 10);
  check("10 次全部判为标准", goodReps === 10);
}

// ---- 测试 2：只跳腿不抬臂 → 触发 arms_low ----
console.log("\n测试 2：手臂没举过头顶");
{
  const ex = createJumpingJackExercise();
  ex.update(CLOSED);
  ex.update(OPEN_ARMS_LOW);
  const r = ex.update(CLOSED);
  check("不抬臂也被计数（count=1）", r.count === 1);
  check("触发『手臂未举过头顶』提示(arms_low)", r.lastRep?.cues.includes("arms_low"));
  check("不抬臂不被判为标准", r.lastRep?.good === false);
}

// ---- 测试 3：腿张得不够开 → 触发 narrow ----
console.log("\n测试 3：双脚张开幅度不足");
{
  const ex = createJumpingJackExercise();
  ex.update(CLOSED);
  ex.update(OPEN_NARROW);
  const r = ex.update(CLOSED);
  check("小幅开合也被计数（count=1）", r.count === 1);
  check("触发『张开幅度不足』提示(narrow)", r.lastRep?.cues.includes("narrow"));
  check("手举到位时不应误报 arms_low", !r.lastRep?.cues.includes("arms_low"));
}

// ---- 测试 4：关键点不可见 → ready=false 且不计数 ----
console.log("\n测试 4：关键点不可见");
{
  const ex = createJumpingJackExercise();
  const hidden = frame(
    {
      nose: { x: 0.50, y: 0.20 },
      ls: { x: 0.45, y: 0.30 }, rs: { x: 0.55, y: 0.30 },
      lw: { x: 0.44, y: 0.55 }, rw: { x: 0.56, y: 0.55 },
      la: { x: 0.48, y: 0.85 }, ra: { x: 0.52, y: 0.85 },
    },
    0.1 // 可见度很低
  );
  const r = ex.update(hidden);
  check("ready=false", r.ready === false);
  check("不计数", r.count === 0);
}

// ---- 测试 5：并拢站立轻微晃动不应误计数 ----
console.log("\n测试 5：站着轻微晃动不误计数");
{
  const ex = createJumpingJackExercise();
  for (let i = 0; i < 20; i++) ex.update(CLOSED);
  const r = ex.update(CLOSED);
  check("count 保持 0", r.count === 0);
}

// ---- 测试 6：滞回防抖——spread 在 1.0~1.3 之间徘徊不应计数 ----
console.log("\n测试 6：临界区徘徊不误计数（滞回）");
{
  const MID = frame({
    nose: { x: 0.50, y: 0.20 },
    ls: { x: 0.45, y: 0.30 }, rs: { x: 0.55, y: 0.30 },
    lw: { x: 0.44, y: 0.55 }, rw: { x: 0.56, y: 0.55 },
    la: { x: 0.44, y: 0.85 }, ra: { x: 0.56, y: 0.85 }, // 踝距 0.12 → spread 1.2（在两阈值之间）
  });
  const ex = createJumpingJackExercise();
  ex.update(CLOSED);
  for (let i = 0; i < 10; i++) {
    ex.update(MID); // 始终没超过 OPEN_RATIO，不应进入「张开」
    ex.update(CLOSED);
  }
  const r = ex.update(CLOSED);
  check("count 保持 0", r.count === 0);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 开合跳（Jumping Jack）状态机 —— 第二个动作，风格与 squat.js 一致。
 *
 * 判定依据（正对摄像头视角天然适合这个动作）：
 *   - 张合信号：spread = 两踝水平间距 / 两肩水平间距（用自身肩宽归一化，离摄像头远近都不影响）。
 *   - 手臂信号：双腕 y 坐标高于鼻子（图像 y 向下，越小越高）→ 手举过头顶。
 *   - 状态机带滞回：spread > OPEN_RATIO 进入「张开」，回落到 < CLOSE_RATIO 才算「并拢」并计 1 次，
 *     两个阈值不同，防止在临界点抖动反复计数（同 squat.js 的套路）。
 *
 * 纠错规则（只用正面 2D 关键点就能稳定检测的两条）：
 *   1. arms_low —— 张开过程中双腕从未同时高于头顶（只跳腿不抬臂 / 抬不到位）。
 *   2. narrow  —— 张开峰值 spread 仍 < FULL_SPREAD（腿没跳开到位）。
 *
 * 规则引擎只负责「判对错 + 给结构化数据」，措辞交给 feedback.js / LLM。
 */
import { POSE } from "../landmarks.js";
import { horizontalDistance, allVisible } from "../geometry.js";

// ---- 阈值常量（可按场地/人调，留了容差防抖动）----
const OPEN_RATIO = 1.3; //  踝距/肩宽 > 1.3 → 进入「张开」。取得宽松些：跳得不够开也先算一次尝试，
//                          是否「开到位」交给下面的 FULL_SPREAD 单独判定（同深蹲 DOWN/SHALLOW 的关系）。
const CLOSE_RATIO = 1.0; // 踝距/肩宽 回落 < 1.0 → 「并拢」，计 1 次。与 OPEN_RATIO 形成滞回。
const FULL_SPREAD = 1.6; // 张开峰值仍 < 1.6 → 判「双脚张开幅度不足」（已计数，但提示跳开些）
const SPREAD_REST = 0.6; // 站立并脚时的典型 spread，作为高亮强度 0 的基准
const SPREAD_MAX = 1.9; //  完全跳开时的典型 spread，作为高亮强度 1 的基准

/**
 * 默认阈值（与上面的常量一一对应）。createJumpingJackExercise(overrides) 可以覆盖其中任意几项，
 * 用于网页上的「判定严格度」预设和细调滑块；不传参数时行为与原来完全一致。
 */
export const JUMPING_JACK_DEFAULTS = Object.freeze({
  openRatio: OPEN_RATIO,
  closeRatio: CLOSE_RATIO,
  fullSpread: FULL_SPREAD,
  spreadRest: SPREAD_REST,
  spreadMax: SPREAD_MAX,
});

// 该动作需要可见的关键点（缺了就不计数、不判错）
const REQUIRED = [
  POSE.NOSE,
  POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER,
  POSE.LEFT_WRIST, POSE.RIGHT_WRIST,
  POSE.LEFT_ANKLE, POSE.RIGHT_ANKLE,
];

/**
 * 开合跳涉及的主要肌群（id 来自 body-muscles，前/后视图分开）。
 * 主发力：三角肌（举臂）、臀中肌（髋外展）、腓肠肌（蹬跳）。
 */
export const JUMPING_JACK_MUSCLES = {
  front: [
    { id: "shoulder-side-left", weight: 1.0 }, // 三角肌中束（举臂，主）
    { id: "shoulder-side-right", weight: 1.0 },
    { id: "shoulder-front-left", weight: 0.7 }, // 三角肌前束
    { id: "shoulder-front-right", weight: 0.7 },
    { id: "adductors-left", weight: 0.5 }, // 内收肌（并腿）
    { id: "adductors-right", weight: 0.5 },
    { id: "tibialis-anterior-left", weight: 0.3 }, // 胫骨前肌（落地稳定）
    { id: "tibialis-anterior-right", weight: 0.3 },
  ],
  back: [
    { id: "gluteus-medius-left", weight: 0.9 }, // 臀中肌（髋外展，主）
    { id: "gluteus-medius-right", weight: 0.9 },
    { id: "calves-gastroc-medial-left", weight: 0.8 }, // 腓肠肌（蹬跳，主）
    { id: "calves-gastroc-medial-right", weight: 0.8 },
    { id: "deltoid-rear-left", weight: 0.6 }, // 三角肌后束
    { id: "deltoid-rear-right", weight: 0.6 },
    { id: "traps-upper-left", weight: 0.4 }, // 上斜方肌（耸臂稳定）
    { id: "traps-upper-right", weight: 0.4 },
  ],
};

export function createJumpingJackExercise(overrides = {}) {
  // 本实例实际使用的阈值（默认值 + 覆盖项）
  const T = { ...JUMPING_JACK_DEFAULTS, ...overrides };
  const { openRatio, closeRatio, fullSpread, spreadRest, spreadMax } = T;

  // 内部可变状态
  let phase = "closed"; // 'closed'（并拢）| 'open'（张开）
  let count = 0;
  let repMaxSpread = 0; //    本次张开过程中的 spread 峰值
  let repArmsUpSeen = false; // 本次张开过程中是否出现过「双腕高于头顶」

  function resetRepTrackers() {
    repMaxSpread = 0;
    repArmsUpSeen = false;
  }

  function reset() {
    phase = "closed";
    count = 0;
    resetRepTrackers();
  }

  /**
   * 每帧调用一次。
   * @param {Array} landmarks 33 个归一化关键点（result.landmarks[0]）
   * @returns 结构化结果，字段约定同 squat.js（ready/count/phase/repCompleted/depthRatio/lastRep…）
   */
  function update(landmarks) {
    // 关键点不可信 → 不更新状态，提示用户站好
    if (!landmarks || !allVisible(landmarks, REQUIRED)) {
      return {
        ready: false,
        count,
        phase,
        phaseLabel: phase === "open" ? "张开" : "并拢",
        repCompleted: false,
        spreadRatio: null,
        metricText: null,
        depthRatio: 0,
        lastRep: null,
      };
    }

    // 1) 张合信号：踝距 / 肩宽（肩宽归一化，远近不变）
    const shoulderWidth = horizontalDistance(
      landmarks[POSE.LEFT_SHOULDER], landmarks[POSE.RIGHT_SHOULDER]
    );
    const ankleWidth = horizontalDistance(
      landmarks[POSE.LEFT_ANKLE], landmarks[POSE.RIGHT_ANKLE]
    );
    const spread = shoulderWidth > 0.001 ? ankleWidth / shoulderWidth : 0;

    // 2) 手臂信号：双腕都高于鼻子（图像 y 向下）→ 手举过头顶
    const nose = landmarks[POSE.NOSE];
    const armsUp =
      landmarks[POSE.LEFT_WRIST].y < nose.y && landmarks[POSE.RIGHT_WRIST].y < nose.y;

    // 3) 实时张开程度（驱动肌肉高亮）：并脚=0，完全跳开=1
    const depthRatio = clamp01((spread - spreadRest) / (spreadMax - spreadRest));

    // 4) 状态机：「张开」阶段持续记录峰值
    if (phase === "open") {
      repMaxSpread = Math.max(repMaxSpread, spread);
      if (armsUp) repArmsUpSeen = true;
    }

    let repCompleted = false;
    let lastRep = null;

    if (phase === "closed" && spread > openRatio) {
      // 并拢 → 张开：开始记录这一次的峰值
      phase = "open";
      resetRepTrackers();
      repMaxSpread = spread;
      repArmsUpSeen = armsUp;
    } else if (phase === "open" && spread < closeRatio) {
      // 张开 → 并拢：完成一次，结算纠错提示
      phase = "closed";
      count += 1;
      repCompleted = true;

      const cues = [];
      if (!repArmsUpSeen) cues.push("arms_low"); // 手臂没举过头顶
      if (repMaxSpread < fullSpread) cues.push("narrow"); // 腿没跳开到位

      lastRep = {
        index: count,
        maxSpread: Number(repMaxSpread.toFixed(2)),
        armsUp: repArmsUpSeen,
        metric: Number(repMaxSpread.toFixed(2)), // 通用「深度统计」字段（squat 是最低膝角）
        cues, // 规则引擎给出的「错误标签」，措辞交给 feedback.js
        good: cues.length === 0,
      };
    }

    return {
      ready: true,
      count,
      phase,
      phaseLabel: phase === "open" ? "张开" : "并拢",
      repCompleted,
      spreadRatio: Number(spread.toFixed(2)),
      metricText: `${spread.toFixed(2)}×`,
      depthRatio,
      lastRep,
      // 以下为附加的实时量（给可视化面板用，不影响计数/判定）
      metricValue: spread,
      armsUp,
      repMaxSpread: phase === "open" ? repMaxSpread : null,
      repArmsUpSeen: phase === "open" ? repArmsUpSeen : null,
    };
  }

  return {
    id: "jumpingJack",
    name: "开合跳",
    instructions: "正对摄像头露出全身，双脚并拢站好；跳开双脚的同时双手举过头顶，再跳回并拢。",
    metricLabel: "踝距/肩宽", // 实时指标的 UI 标签（squat 是「膝关节角度」）
    repMetricLabel: "张开峰值(踝距/肩宽)", // 「深度统计」喂给 LLM 时的说明
    muscleGroups: JUMPING_JACK_MUSCLES,
    thresholds: T,
    required: REQUIRED, // 计数必需的关键点下标（给可视化面板标注用）
    update,
    reset,
  };
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

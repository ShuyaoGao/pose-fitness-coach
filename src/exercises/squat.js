/**
 * 深蹲（Squat）状态机 —— 本项目「原创规则」所在。
 *
 * 设计要点（详见 开发决策与假设.md）：
 *  - 不训练任何模型：拿到关键点后，用向量几何算膝关节角度，再用「带滞回阈值的状态机」计数。
 *  - 纠错规则只用「正对摄像头也能稳定检测」的两条：
 *      1. 蹲得不够深（最低点膝角仍过大）
 *      2. 膝盖内扣 knee valgus（下蹲时两膝间距明显小于两踝间距）
 *  - 「躯干前倾/弯腰」属深度方向，单 RGB 正面摄像头测不准，MVP 不做（留第二阶段）。
 *  - 规则引擎只负责「判对错 + 给结构化数据」，措辞交给 feedback.js（第二阶段换 LLM）。
 */
import { POSE } from "../landmarks.js";
import { angleAt, horizontalDistance, allVisible } from "../geometry.js";

// ---- 阈值常量（可按场地/人调，留了容差防抖动）----
const STAND_ANGLE = 170; // 站直时膝角约 170°，作为 depthRatio=0 的基准
const DEEP_TARGET = 90; //  蹲到大腿约与地面平行时膝角约 90°，作为 depthRatio=1 的基准
const UP_ANGLE = 160; //   膝角 > 160° 认为「站起」（状态机上阈值）
const DOWN_ANGLE = 130; //  膝角 < 130° 认为「已下蹲」（开始算一次尝试）。上下阈值不同 = 滞回，防反复横跳。
//                          注意：这里取较宽松的 130°，目的是「哪怕蹲得浅也算一次并能提示你不够深」；
//                          是否「蹲到位」交给下面的 SHALLOW_ANGLE 单独判定。
const SHALLOW_ANGLE = 105; // 本次最低点膝角仍 > 105° → 判「不够深」（已计数，但提示加深）
const VALGUS_RATIO = 0.55; // 最低点「膝间距/踝间距」< 0.55 → 判「膝盖内扣」

/**
 * 默认阈值（与上面的常量一一对应）。createSquatExercise(overrides) 可以覆盖其中任意几项，
 * 用于网页上的「判定严格度」预设和细调滑块；不传参数时行为与原来完全一致。
 */
export const SQUAT_DEFAULTS = Object.freeze({
  standAngle: STAND_ANGLE,
  deepTarget: DEEP_TARGET,
  upAngle: UP_ANGLE,
  downAngle: DOWN_ANGLE,
  shallowAngle: SHALLOW_ANGLE,
  valgusRatio: VALGUS_RATIO,
});

// 该动作需要可见的关键点（缺了就不计数、不判错）
const REQUIRED = [
  POSE.LEFT_HIP, POSE.RIGHT_HIP,
  POSE.LEFT_KNEE, POSE.RIGHT_KNEE,
  POSE.LEFT_ANKLE, POSE.RIGHT_ANKLE,
];

/**
 * 深蹲涉及的主要肌群，按「前视图 / 后视图」分开（body-muscles 的肌肉分属两个视图）。
 * weight 是相对发力权重（0~1），main.js 据此把「蹲的深度」映射成肌肉高亮强度。
 */
export const SQUAT_MUSCLES = {
  front: [
    { id: "quads-left", weight: 1.0 }, // 股四头肌（主）
    { id: "quads-right", weight: 1.0 },
    { id: "adductors-left", weight: 0.6 }, // 内收肌（协同）
    { id: "adductors-right", weight: 0.6 },
  ],
  back: [
    { id: "gluteus-maximus-left", weight: 1.0 }, // 臀大肌（主）
    { id: "gluteus-maximus-right", weight: 1.0 },
    { id: "hamstrings-medial-left", weight: 0.7 }, // 腘绳肌（协同）
    { id: "hamstrings-lateral-left", weight: 0.7 },
    { id: "hamstrings-medial-right", weight: 0.7 },
    { id: "hamstrings-lateral-right", weight: 0.7 },
    { id: "lower-back-erectors-left", weight: 0.4 }, // 竖脊肌（稳定）
    { id: "lower-back-erectors-right", weight: 0.4 },
    { id: "calves-gastroc-medial-left", weight: 0.3 }, // 小腿（稳定）
    { id: "calves-gastroc-medial-right", weight: 0.3 },
  ],
};

export function createSquatExercise(overrides = {}) {
  // 本实例实际使用的阈值（默认值 + 覆盖项）
  const T = { ...SQUAT_DEFAULTS, ...overrides };
  const { standAngle, deepTarget, upAngle, downAngle, shallowAngle, valgusRatio: valgusLimit } = T;

  // 内部可变状态
  let phase = "up"; // 'up' | 'down'
  let count = 0;
  let repMinKneeAngle = 180; // 本次下蹲过程中达到的最小膝角
  let repMinValgusRatio = 2; // 本次下蹲过程中「膝间距/踝间距」的最小值

  function resetRepTrackers() {
    repMinKneeAngle = 180;
    repMinValgusRatio = 2;
  }

  function reset() {
    phase = "up";
    count = 0;
    resetRepTrackers();
  }

  /**
   * 每帧调用一次。
   * @param {Array} landmarks 33 个归一化关键点（result.landmarks[0]）
   * @returns 结构化结果（见文件顶部说明）
   */
  function update(landmarks) {
    // 关键点不可信 → 不更新状态，提示用户站好
    if (!landmarks || !allVisible(landmarks, REQUIRED)) {
      return {
        ready: false,
        count,
        phase,
        phaseLabel: phase === "down" ? "下蹲" : "站立",
        repCompleted: false,
        kneeAngle: null,
        metricText: null,
        depthRatio: 0,
        lastRep: null,
      };
    }

    // 1) 算左右膝角并取平均（hip-knee-ankle 夹角）
    const leftKnee = angleAt(
      landmarks[POSE.LEFT_HIP], landmarks[POSE.LEFT_KNEE], landmarks[POSE.LEFT_ANKLE]
    );
    const rightKnee = angleAt(
      landmarks[POSE.RIGHT_HIP], landmarks[POSE.RIGHT_KNEE], landmarks[POSE.RIGHT_ANKLE]
    );
    const kneeAngle = (leftKnee + rightKnee) / 2;

    // 2) 算膝盖内扣比例：两膝水平间距 / 两踝水平间距
    const kneeWidth = horizontalDistance(landmarks[POSE.LEFT_KNEE], landmarks[POSE.RIGHT_KNEE]);
    const ankleWidth = horizontalDistance(landmarks[POSE.LEFT_ANKLE], landmarks[POSE.RIGHT_ANKLE]);
    const valgusRatio = ankleWidth > 0.001 ? kneeWidth / ankleWidth : 2;

    // 3) 实时蹲深（驱动肌肉高亮）：站直=0，蹲到位=1
    const depthRatio = clamp01((standAngle - kneeAngle) / (standAngle - deepTarget));

    // 4) 状态机：处于「蹲下」阶段时持续记录极值
    if (phase === "down") {
      repMinKneeAngle = Math.min(repMinKneeAngle, kneeAngle);
      repMinValgusRatio = Math.min(repMinValgusRatio, valgusRatio);
    }

    let repCompleted = false;
    let lastRep = null;

    if (phase === "up" && kneeAngle < downAngle) {
      // 站立 → 蹲下：开始记录这一次的极值
      phase = "down";
      resetRepTrackers();
      repMinKneeAngle = kneeAngle;
      repMinValgusRatio = valgusRatio;
    } else if (phase === "down" && kneeAngle > upAngle) {
      // 蹲下 → 站起：完成一次，结算纠错提示
      phase = "up";
      count += 1;
      repCompleted = true;

      const cues = [];
      if (repMinKneeAngle > shallowAngle) cues.push("shallow"); // 不够深
      if (repMinValgusRatio < valgusLimit) cues.push("valgus"); // 膝内扣

      lastRep = {
        index: count,
        minKneeAngle: Math.round(repMinKneeAngle),
        minValgusRatio: Number(repMinValgusRatio.toFixed(2)),
        metric: Math.round(repMinKneeAngle), // 通用「深度统计」字段（开合跳是张开峰值）
        cues, // 规则引擎给出的「错误标签」，措辞交给 feedback.js
        good: cues.length === 0,
      };
    }

    return {
      ready: true,
      count,
      phase,
      phaseLabel: phase === "down" ? "下蹲" : "站立",
      repCompleted,
      kneeAngle: Math.round(kneeAngle),
      metricText: `${Math.round(kneeAngle)}°`,
      depthRatio,
      lastRep,
      // 以下为附加的实时量（给可视化面板用，不影响计数/判定）
      metricValue: kneeAngle,
      valgusRatio,
      repMinKneeAngle: phase === "down" ? repMinKneeAngle : null,
      repMinValgusRatio: phase === "down" ? repMinValgusRatio : null,
    };
  }

  return {
    id: "squat",
    name: "深蹲",
    instructions: "正对摄像头站好，露出从头到脚，双脚与肩同宽，缓慢下蹲再站起。",
    metricLabel: "膝关节角度", // 实时指标的 UI 标签（开合跳是「踝距/肩宽」）
    repMetricLabel: "最低膝角(°)", // 「深度统计」喂给 LLM 时的说明
    muscleGroups: SQUAT_MUSCLES,
    thresholds: T,
    required: REQUIRED, // 计数必需的关键点下标（给可视化面板标注用）
    update,
    reset,
  };
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

/**
 * presets.js —— 「判定严格度」预设档位 + 细调滑块的定义。
 *
 * 只改判定阈值，不改规则本身。数值都会原样传给
 * createSquatExercise(overrides) / createJumpingJackExercise(overrides)。
 * 「标准」档 = 规则文件里的默认值（SQUAT_DEFAULTS / JUMPING_JACK_DEFAULTS）。
 */
import { SQUAT_DEFAULTS } from "../src/exercises/squat.js";
import { JUMPING_JACK_DEFAULTS } from "../src/exercises/jumpingJack.js";

export const PRESET_ORDER = ["loose", "standard", "strict", "custom"];

export const PRESET_LABELS = {
  loose: "宽松",
  standard: "标准",
  strict: "严格",
  custom: "自定义",
};

/** 每档的一句话说明（显示在档位按钮下方）。 */
export const PRESET_DESC = {
  squat: {
    loose: "新手档：膝角低于 115° 就算蹲到位，膝距/踝距不低于 0.45 就不算内扣。",
    standard: "默认档：膝角低于 105° 算蹲到位，膝距/踝距低于 0.55 判内扣。",
    strict: "严格档：要蹲到膝角低于 95°，膝距/踝距低于 0.65 就判内扣。",
    custom: "自定义：用下面的滑块逐项调阈值。",
  },
  jumpingJack: {
    loose: "新手档：踝距达到肩宽的 1.45 倍就算跳开到位。",
    standard: "默认档：踝距要达到肩宽的 1.6 倍。",
    strict: "严格档：踝距要达到肩宽的 1.8 倍。",
    custom: "自定义：用下面的滑块逐项调阈值。",
  },
};

export const PRESETS = {
  squat: {
    loose: { shallowAngle: 115, valgusRatio: 0.45 },
    standard: {},
    strict: { shallowAngle: 95, valgusRatio: 0.65 },
  },
  jumpingJack: {
    loose: { fullSpread: 1.45 },
    standard: {},
    strict: { fullSpread: 1.8 },
  },
};

export const DEFAULTS = { squat: SQUAT_DEFAULTS, jumpingJack: JUMPING_JACK_DEFAULTS };

/** 细调滑块：key 对应 overrides 的字段。 */
export const SLIDERS = {
  squat: [
    { key: "downAngle", label: "下蹲线：膝角低于它进入「下蹲」", min: 110, max: 150, step: 1, unit: "°" },
    { key: "upAngle", label: "站起线：膝角高于它算「站起」并计数", min: 140, max: 175, step: 1, unit: "°" },
    { key: "shallowAngle", label: "蹲深线：最低膝角高于它判「不够深」", min: 80, max: 125, step: 1, unit: "°" },
    { key: "valgusRatio", label: "内扣线：膝距/踝距低于它判「膝盖内扣」", min: 0.3, max: 0.9, step: 0.01, unit: "" },
  ],
  jumpingJack: [
    { key: "openRatio", label: "张开线：踝距/肩宽高于它进入「张开」", min: 1.1, max: 1.6, step: 0.01, unit: "×" },
    { key: "closeRatio", label: "并拢线：踝距/肩宽低于它算「并拢」并计数", min: 0.7, max: 1.2, step: 0.01, unit: "×" },
    { key: "fullSpread", label: "到位线：张开峰值低于它判「张开不足」", min: 1.3, max: 2.1, step: 0.01, unit: "×" },
  ],
};

/** 取某个动作某一档的完整阈值（默认值 + 档位覆盖）。 */
export function thresholdsFor(exercise, preset, custom = null) {
  const base = { ...DEFAULTS[exercise] };
  if (preset === "custom" && custom) return { ...base, ...custom };
  return { ...base, ...(PRESETS[exercise][preset] ?? {}) };
}

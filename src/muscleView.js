/**
 * 肌肉可视化封装 —— 调用开源库 body-muscles（Apache-2.0，零依赖 SVG）。
 * 老师要求「调现成库、别自己画解剖图」，这里就是那一层薄封装。
 *
 * 关键点：深蹲的主要肌群分布在身体「前面」（股四头肌）和「背面」（臀大肌、腘绳肌），
 * body-muscles 的 FRONT / BACK 是两套独立 SVG，所以我们并排渲染两张图，
 * 前后视图同时随动作高亮。
 *
 * 库 API：
 *   new BodyChart(containerEl, { view, bodyState })
 *   chart.update({ bodyState })   // 局部更新颜色
 * bodyState 形如 { "quads-left": { intensity: 0~10, selected: true } }
 */
import { BodyChart, ViewSide } from "body-muscles";

export function createMuscleView(frontContainer, backContainer) {
  const frontChart = new BodyChart(frontContainer, {
    view: ViewSide.FRONT,
    bodyState: {},
    showViewLabel: true,
  });
  const backChart = new BodyChart(backContainer, {
    view: ViewSide.BACK,
    bodyState: {},
    showViewLabel: true,
  });

  /**
   * 把「动作的肌群定义 + 当前强度(0~1)」映射成 body-muscles 的 bodyState 并刷新。
   * @param {{front: Array<{id,weight}>, back: Array<{id,weight}>}} muscleGroups 动作涉及的肌群
   * @param {number} intensity01 当前发力强度 0~1（深蹲用蹲的深度 depthRatio）
   */
  function highlight(muscleGroups, intensity01) {
    frontChart.update({ bodyState: buildState(muscleGroups.front, intensity01) });
    backChart.update({ bodyState: buildState(muscleGroups.back, intensity01) });
  }

  /** 清空高亮（回到灰色静息态）。 */
  function clear() {
    frontChart.update({ bodyState: {} });
    backChart.update({ bodyState: {} });
  }

  return { highlight, clear };
}

/**
 * 由肌群列表 + 强度生成 bodyState。
 * 映射：基础亮度 0.2 + 0.8×强度，再乘以该肌肉的发力权重，缩放到 1~10。
 * 这样静息时也微微可见，发力越深越红。
 */
function buildState(muscles, intensity01) {
  const state = {};
  const base = 0.2 + 0.8 * clamp01(intensity01);
  for (const { id, weight } of muscles) {
    const level = Math.round(base * weight * 10);
    state[id] = { intensity: Math.min(Math.max(level, 1), 10), selected: false };
  }
  return state;
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

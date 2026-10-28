/**
 * 纯几何工具：用关键点坐标算关节角度、距离等。
 * 这部分不依赖任何库——拿到坐标后全是中学向量几何，是本项目「原创规则」的基础。
 *
 * 每个点都是 { x, y, (z), visibility } 形式（来自 MediaPipe 关键点）。
 */

/** 把数值限制在 [min, max] 区间内。 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 计算「以 b 为顶点，由 a-b-c 三点构成的夹角」，返回角度（0~180°）。
 * 例：算膝关节角度就传 (髋, 膝, 踝)。
 *
 * 原理：求向量 ba 和 bc 的夹角，cosθ = (ba·bc) / (|ba|·|bc|)。
 * 只用 x、y（图像平面），对「正对/侧对摄像头的标准动作」足够稳。
 */
export function angleAt(a, b, c) {
  const baX = a.x - b.x;
  const baY = a.y - b.y;
  const bcX = c.x - b.x;
  const bcY = c.y - b.y;

  const dot = baX * bcX + baY * bcY;
  const magBa = Math.hypot(baX, baY);
  const magBc = Math.hypot(bcX, bcY);

  if (magBa === 0 || magBc === 0) return 0; // 退化情况，避免除以 0
  const cos = clamp(dot / (magBa * magBc), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 两点在图像平面上的水平距离（只看 x）。用于判断「膝盖间距 / 踝间距」。 */
export function horizontalDistance(p1, p2) {
  return Math.abs(p1.x - p2.x);
}

/** 两点在图像平面上的欧氏距离。 */
export function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

/**
 * 判断一组关键点是否都「足够可见」。
 * MediaPipe 给每个点一个 visibility，被遮挡/出画面时会变低。
 * 关键点不可信时，我们宁可不计数、不判错，也不要误判。
 */
export function allVisible(landmarks, indices, threshold = 0.5) {
  return indices.every((i) => {
    const lm = landmarks[i];
    return lm && (lm.visibility ?? 0) >= threshold;
  });
}

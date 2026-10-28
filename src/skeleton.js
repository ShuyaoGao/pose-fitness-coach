/**
 * 在 canvas 上把 33 个关键点连成「骨架」画出来。
 * 用官方提供的 PoseLandmarker.POSE_CONNECTIONS 连线表，避免手写一堆连线对。
 */
import { PoseLandmarker } from "@mediapipe/tasks-vision";

/**
 * 绘制骨架。
 * @param {CanvasRenderingContext2D} ctx 画布上下文（尺寸应与视频显示区一致）
 * @param {Array<{x:number,y:number,visibility?:number}>} landmarks 33 个归一化关键点
 * @param {object} [opts]
 * @param {string} [opts.lineColor] 连线颜色
 * @param {string} [opts.pointColor] 关键点颜色
 * @param {number} [opts.minVisibility] 低于此可见度的点不画
 */
export function drawSkeleton(ctx, landmarks, opts = {}) {
  const {
    lineColor = "#22d3ee", // 青色连线
    pointColor = "#f8fafc", // 近白色关节点
    minVisibility = 0.4,
  } = opts;

  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  ctx.clearRect(0, 0, w, h);
  if (!landmarks || landmarks.length === 0) return;

  // 1) 先画连线
  ctx.lineWidth = 4;
  ctx.strokeStyle = lineColor;
  for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
    const a = landmarks[start];
    const b = landmarks[end];
    if (!a || !b) continue;
    if ((a.visibility ?? 1) < minVisibility || (b.visibility ?? 1) < minVisibility) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }

  // 2) 再画关节点
  ctx.fillStyle = pointColor;
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < minVisibility) continue;
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

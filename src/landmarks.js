/**
 * MediaPipe Pose Landmarker（BlazePose）输出 33 个关键点。
 * 这里把我们会用到的关键点下标取个有意义的名字，避免代码里到处写 magic number。
 *
 * 完整 33 点定义见官方文档：
 * https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 *
 * 坐标说明：每个关键点是 { x, y, z, visibility }
 *   - x, y：归一化到 [0,1] 的图像坐标（左上角为原点，x 向右，y 向下）。
 *   - z：相对深度（越小越靠近摄像头），单 RGB 摄像头下不太准，MVP 基本不用。
 *   - visibility：该点可见/可信度 [0,1]，被遮挡时会变低。
 */
export const POSE = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
};

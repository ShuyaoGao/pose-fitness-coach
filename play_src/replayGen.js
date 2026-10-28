/**
 * replayGen.js —— 程序合成的「示例动作」骨架数据（不是真人录制）。
 *
 * 为什么要合成：离线网页没开摄像头时也要有东西可看；而且每条纠错规则都需要一段
 * 「刻意做错」的示例。这里用一个简单的正面人体骨架模型，按时间曲线生成 33 个关键点，
 * 格式与 MediaPipe Pose Landmarker 的输出一致（x, y 归一化到 [0,1]，带 visibility）。
 *
 * 生成过程完全确定（固定随机种子），浏览器和 Node 测试里生成的帧逐位相同。
 * 帧率 30 fps；画面按 640×480 像素设计，再归一化（和真摄像头一样，x 除以宽、y 除以高）。
 *
 * 纯函数、无 DOM 依赖：play 页面和 tests/replay.test.mjs 共用。
 */

export const FPS = 30;
const W = 640;
const H = 480;

/** 示例片段清单（顺序即下拉框顺序）。peak 等参数决定最低膝角 / 张开峰值，见 results/result.json。 */
export const CLIPS = [
  {
    id: "squat_good",
    exercise: "squat",
    name: "深蹲 · 标准（5 次）",
    note: "膝盖对准脚尖、蹲到大腿接近水平。标准档全部通过；换成「严格」档会出现「不够深」。",
    reps: 5,
    params: { depth: 1.0, kneeOut: 34, stance: 26 },
  },
  {
    id: "squat_shallow",
    exercise: "squat",
    name: "深蹲 · 蹲太浅（4 次）",
    note: "每次只蹲到一半就站起来。标准档判「不够深」；换成「宽松」档就算通过。",
    reps: 4,
    params: { depth: 0.93, kneeOut: 34, stance: 26 },
  },
  {
    id: "squat_valgus",
    exercise: "squat",
    name: "深蹲 · 膝盖内扣（4 次）",
    note: "蹲得够深，但两膝向内夹。看右栏「本次判定依据」：膝距/踝距低于阈值。换成「宽松」档就算通过。",
    reps: 4,
    params: { depth: 1.08, kneeOut: -12, stance: 48, hipW: 36 },
  },
  {
    id: "squat_cropped",
    exercise: "squat",
    name: "深蹲 · 脚出了画面（不计数）",
    note: "离镜头太近，脚踝在画面外，姿态网络给出的可见度很低。规则宁可不计数也不乱判。",
    reps: 3,
    params: { depth: 1.0, kneeOut: 34, stance: 26, cropped: true },
  },
  {
    id: "jj_good",
    exercise: "jumpingJack",
    name: "开合跳 · 标准（6 次）",
    note: "跳开超过肩宽、双手在头顶上方合拢。标准档全部通过；「严格」档会嫌跳得不够开。",
    reps: 6,
    params: { open: 0.97, armMax: 168 },
  },
  {
    id: "jj_arms_low",
    exercise: "jumpingJack",
    name: "开合跳 · 手没举过头顶（5 次）",
    note: "腿跳开了，但手只抬到肩膀高度。这条规则看的是「双腕是否高于鼻子」，没有阈值可调。",
    reps: 5,
    params: { open: 0.97, armMax: 95 },
  },
  {
    id: "jj_narrow",
    exercise: "jumpingJack",
    name: "开合跳 · 腿没跳开（5 次）",
    note: "手举过头了，但双脚只张开一点。标准档判「张开不足」；「宽松」档算通过。",
    reps: 5,
    params: { open: 0.8, armMax: 168 },
  },
];

export function getClipMeta(id) {
  return CLIPS.find((c) => c.id === id) ?? null;
}

// ---------------- 小工具 ----------------

/** 确定性伪随机数（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (1 - Math.cos(Math.PI * Math.min(Math.max(t, 0), 1))) / 2;

// ---------------- 正面骨架模型（像素坐标） ----------------
//
// 约定：人正对镜头，人的「左侧」出现在画面右侧（x 较大），与 MediaPipe 对未镜像图像的输出一致。
// side = +1 表示人的左侧，-1 表示右侧。

/**
 * 由姿态参数生成 33 个像素坐标点。
 * @param {object} p
 *   cx, ty           身体中心 x、整体上下偏移（跳跃）
 *   d                下蹲程度 0~1
 *   kneeOut          蹲到底时膝盖向外移动的像素（负数 = 向内扣）
 *   stance           脚踝半间距（像素）
 *   armFwd           深蹲时手臂前平举程度 0~1
 *   armAngle         开合跳手臂外展角（度，0=自然下垂，180=竖直向上）；null 表示用 armFwd
 *   scale, oy        画面缩放与下移（用于「离镜头太近」）
 */
function bodyPixels(p) {
  const { cx = 320, ty = 0, d = 0, kneeOut = 0, stance = 24, hipW = 20, armFwd = 0, armAngle = null } = p;
  const pts = new Array(33);
  const hipDrop = 74 * d;
  const torsoDrop = 84 * d; // 上身略前倾，正面看肩膀下降得比髋多一点
  const sy = 152 + torsoDrop + ty; // 肩 y
  const hy = 268 + hipDrop + ty; // 髋 y
  const ky = 350 + 4 * d + ty; // 膝 y
  const ay = 432 + ty; // 踝 y
  const headY = 98 + torsoDrop + ty;

  // 头部
  pts[0] = [cx, headY];
  pts[1] = [cx + 6, headY - 8]; pts[2] = [cx + 10, headY - 8]; pts[3] = [cx + 14, headY - 8];
  pts[4] = [cx - 6, headY - 8]; pts[5] = [cx - 10, headY - 8]; pts[6] = [cx - 14, headY - 8];
  pts[7] = [cx + 22, headY - 4]; pts[8] = [cx - 22, headY - 4];
  pts[9] = [cx + 6, headY + 10]; pts[10] = [cx - 6, headY + 10];

  for (const side of [1, -1]) {
    const L = side === 1; // 人的左侧
    const sh = [cx + side * 36, sy];
    // 手臂
    let el;
    let wr;
    if (armAngle != null) {
      const th = (armAngle * Math.PI) / 180;
      const dir = [side * Math.sin(th), Math.cos(th)];
      el = [sh[0] + dir[0] * 62, sh[1] + dir[1] * 62];
      wr = [sh[0] + dir[0] * 120, sh[1] + dir[1] * 120];
    } else {
      // 手臂前平举：正面看手臂朝向镜头，投影变短
      el = [sh[0] + side * lerp(6, -4, armFwd), sh[1] + lerp(62, 18, armFwd)];
      wr = [sh[0] + side * lerp(8, -10, armFwd), sh[1] + lerp(120, 22, armFwd)];
    }
    const hip = [cx + side * (hipW + 6 * d), hy];
    const knee = [cx + side * (22 + kneeOut * d + (stance - 24) * 0.6), ky];
    const ank = [cx + side * stance, ay];

    const i = (l, r) => (L ? l : r);
    pts[i(11, 12)] = sh;
    pts[i(13, 14)] = el;
    pts[i(15, 16)] = wr;
    pts[i(17, 18)] = [wr[0] + side * 5, wr[1] + 10];
    pts[i(19, 20)] = [wr[0] + side * 1, wr[1] + 12];
    pts[i(21, 22)] = [wr[0] - side * 4, wr[1] + 8];
    pts[i(23, 24)] = hip;
    pts[i(25, 26)] = knee;
    pts[i(27, 28)] = ank;
    pts[i(29, 30)] = [ank[0], ank[1] + 8];
    pts[i(31, 32)] = [ank[0] + side * 5, ank[1] + 16];
  }
  return pts;
}

/** 像素点 → MediaPipe 风格的归一化关键点，并加入很小的抖动和可见度。 */
function toLandmarks(pts, rand, { scale = 1, oy = 0, lowVis = null } = {}) {
  return pts.map(([x, y], idx) => {
    const jx = (rand() - 0.5) * 1.6;
    const jy = (rand() - 0.5) * 1.6;
    const X = 320 + (x - 320) * scale + jx;
    const Y = oy + y * scale + jy;
    let vis = 0.93 + rand() * 0.06;
    if (lowVis && lowVis.has(idx)) vis = 0.05 + rand() * 0.1;
    if (X < 0 || X > W || Y < 0 || Y > H) vis = Math.min(vis, 0.12);
    return {
      x: Number((X / W).toFixed(4)),
      y: Number((Y / H).toFixed(4)),
      z: 0,
      visibility: Number(vis.toFixed(3)),
    };
  });
}

// ---------------- 时间曲线 ----------------

/** 深蹲：每次 2.4 秒（下 1.0 s、底部停 0.2 s、起 1.0 s、站 0.2 s）。返回每帧的 d。 */
function squatTimeline(reps, peaks) {
  const out = [];
  const hold = (n, v) => { for (let i = 0; i < n; i++) out.push(v); };
  hold(FPS * 1, 0);
  for (let r = 0; r < reps; r++) {
    const pk = peaks[r];
    for (let i = 0; i < 30; i++) out.push(pk * ease(i / 29));
    hold(6, pk);
    for (let i = 0; i < 30; i++) out.push(pk * (1 - ease(i / 29)));
    hold(6, 0);
  }
  hold(FPS * 1, 0);
  return out;
}

/** 开合跳：每次 1.0 秒，张开程度按余弦曲线 0→峰值→0。 */
function jackTimeline(reps, peaks) {
  const out = [];
  const hold = (n, v) => { for (let i = 0; i < n; i++) out.push(v); };
  hold(FPS * 1, 0);
  for (let r = 0; r < reps; r++) {
    const pk = peaks[r];
    for (let i = 0; i < 30; i++) out.push(pk * (1 - Math.cos((2 * Math.PI * i) / 30)) / 2);
  }
  hold(FPS * 1, 0);
  return out;
}

// ---------------- 对外：生成一个片段 ----------------

const cache = new Map();

/**
 * 生成片段的全部帧。
 * @param {string} id CLIPS 里的 id
 * @returns {{meta: object, fps: number, frames: Array<Array<{x,y,z,visibility}>>}}
 */
export function generateClip(id) {
  if (cache.has(id)) return cache.get(id);
  const meta = getClipMeta(id);
  if (!meta) throw new Error(`未知片段：${id}`);
  const clip = buildClip(meta);
  cache.set(id, clip);
  return clip;
}

/** 按片段描述生成帧（generateClip 的实际实现；单独导出便于调参）。 */
export function buildClip(meta) {
  const id = meta.id;
  const rand = rng(hashStr(id));
  const P = meta.params;
  // 每次动作的幅度有一点点随机差异（±3%），更像真人；不会越过判定阈值（见 tests/replay.test.mjs）
  const peaks = Array.from({ length: meta.reps }, () => P.depth ?? P.open);
  for (let r = 0; r < peaks.length; r++) peaks[r] *= 0.985 + rand() * 0.03;

  const frames = [];
  if (meta.exercise === "squat") {
    const tl = squatTimeline(meta.reps, peaks);
    const lowVis = P.cropped ? new Set([25, 26, 27, 28, 29, 30, 31, 32]) : null;
    for (const d of tl) {
      const pts = bodyPixels({ d, kneeOut: P.kneeOut, stance: P.stance, hipW: P.hipW, armFwd: Math.min(1, d * 1.3) });
      frames.push(toLandmarks(pts, rand, P.cropped ? { scale: 1.45, oy: -40, lowVis } : {}));
    }
  } else {
    const tl = jackTimeline(meta.reps, peaks);
    for (const o of tl) {
      const stance = lerp(20, 64, o); // 踝半间距：并脚 20 px → 张开 64 px
      const armAngle = lerp(12, P.armMax, Math.min(1, o / Math.max(P.open, 0.01)));
      const ty = -10 * Math.sin(Math.PI * Math.min(1, o / Math.max(P.open, 0.01))); // 起跳
      const pts = bodyPixels({ d: 0, stance, kneeOut: 0, ty, armAngle });
      // 开合跳时膝盖跟着脚一起外移
      for (const [k, a] of [[25, 27], [26, 28]]) pts[k] = [lerp(pts[k][0], pts[a][0], 0.55), pts[k][1]];
      frames.push(toLandmarks(pts, rand));
    }
  }
  return { meta, fps: FPS, frames };
}

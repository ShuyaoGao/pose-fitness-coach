/**
 * 语音播报 —— 浏览器自带 Web Speech API（speechSynthesis），零依赖、离线可用。
 *
 * 设计要点：
 *   - 计数播报（"5"）短促高频 → 标记为 skippable：引擎正忙时直接跳过，不排队，
 *     否则快速连做几次后语音会越积越多、和画面脱节。
 *   - 纠错提示防刷屏：同一条提示在 DEDUPE_MS 内只播一次（连续好几次都内扣时不会每次都念一遍）。
 *   - 浏览器不支持 speechSynthesis 时整体静默（supported=false），UI 可据此禁用开关。
 */

const DEDUPE_MS = 6000; // 同一条纠错提示的最小重播间隔

export function createSpeaker() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  let enabled = true; // 默认开
  const lastSpokenAt = new Map(); // dedupeKey → 上次播报时间戳

  /**
   * 播报一段中文。
   * @param {string} text
   * @param {{dedupeKey?:string, dedupeMs?:number, skippable?:boolean}} opts
   *   - dedupeKey：去重键，相同键在 dedupeMs 内不重复播报（用于纠错提示防刷屏）
   *   - skippable：引擎正在说话时直接放弃（用于计数，宁可漏报不要积压）
   */
  function speak(text, { dedupeKey = null, dedupeMs = DEDUPE_MS, skippable = false } = {}) {
    if (!supported || !enabled || !text) return;
    if (skippable && (speechSynthesis.speaking || speechSynthesis.pending)) return;
    if (dedupeKey) {
      const now = Date.now();
      const last = lastSpokenAt.get(dedupeKey) ?? -Infinity;
      if (now - last < dedupeMs) return;
      lastSpokenAt.set(dedupeKey, now);
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.1; // 稍快一点，跟得上动作节奏
    speechSynthesis.speak(u);
  }

  /** 开/关播报；关闭时立即打断当前语音。 */
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled && supported) speechSynthesis.cancel();
  }

  return {
    supported,
    speak,
    setEnabled,
    isEnabled: () => enabled,
  };
}

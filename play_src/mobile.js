/**
 * mobile.js —— 手机竖屏通用工具（不含任何规则逻辑；打包进 play/app.js）。
 *
 *   detect(opts)             触屏 + 宽度 ≤ 980px + 竖屏 → body.touchp；触屏横屏（宽 ≤ 980px）→ body.touchl；
 *                            任何触屏 → body.touch。窗口尺寸 / 方向变化时自动更新，变化后调 opts.onChange(state)。
 *   menu(btn, box)           ☰ 菜单：点按钮开关，点菜单项 / 点外面 / Esc 关闭。
 *   sheets(closeBtn, onChange) 全屏面板控制器：open('panel') 给 body 加 sheet-panel，close() 去掉；
 *                            共用一个「返回」按钮；返回 {open, close, toggle, current}。
 *   rotateHint(okBtn)        横屏提示：点「仍然横屏继续」给 body 加 rot-ok；转回竖屏时自动清掉。
 *   pressFeedback(root, sel) 按下时给元素加 .pressed 并轻微振动（navigator.vibrate，失败静默）；
 *                            抬起 / 取消 / 窗口失焦时全部清掉。
 *   guard(root, opts)        防误触：触屏下禁止长按菜单、iOS 捏合手势；窗口失焦、页面隐藏、
 *                            所有手指离开时调 opts.onReset()。
 *   destroy()                退出时解绑全部监听。
 *
 * 所有样式挂在 style.css 的 body.touchp / body.touchl / body.sheet-* 下面。
 */
const state = { touch: false, touchp: false, touchl: false, maxWidth: 980 };
let bound = [];
let changeCbs = [];

function on(el, ev, fn, opt) {
  el.addEventListener(ev, fn, opt);
  bound.push([el, ev, fn, opt]);
}

export function vibrate(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* 不支持时静默 */
  }
}

function mm(q) {
  try {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  } catch {
    return false;
  }
}

/** “触屏设备” = 主要输入是手指：粗指针，或者有触摸点但没有悬停能力。
 *  带触摸屏的笔记本（有鼠标、能悬停）不算，仍用键鼠布局和键盘说明。 */
function isTouchDevice() {
  const capable = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  return mm("(pointer: coarse)") || (capable && !mm("(hover: hover)"));
}

function classify() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const touch = isTouchDevice();
  const portrait = h >= w;
  const next = {
    touch,
    touchp: touch && portrait && w <= state.maxWidth,
    touchl: touch && !portrait && w <= state.maxWidth,
  };
  const changed = next.touch !== state.touch || next.touchp !== state.touchp || next.touchl !== state.touchl;
  Object.assign(state, next);
  const b = document.body;
  b.classList.toggle("touch", state.touch);
  b.classList.toggle("touchp", state.touchp);
  b.classList.toggle("touchl", state.touchl);
  if (!state.touchl) b.classList.remove("rot-ok");
  return changed;
}

export function detect(opts = {}) {
  if (opts.maxWidth) state.maxWidth = opts.maxWidth;
  if (opts.onChange) changeCbs.push(opts.onChange);
  classify();
  let t = null;
  const relayout = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (classify()) changeCbs.forEach((cb) => cb(state));
    }, 80);
  };
  on(window, "resize", relayout);
  on(window, "orientationchange", relayout);
  return state;
}

export function menu(btn, box) {
  if (!btn || !box) return null;
  const set = (open) => {
    box.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  on(btn, "click", (e) => {
    e.stopPropagation();
    set(box.hidden);
  });
  on(box, "click", (e) => {
    if (e.target.closest("button, a")) set(false);
  });
  on(document, "click", (e) => {
    if (!box.hidden && !box.contains(e.target) && e.target !== btn) set(false);
  });
  on(document, "keydown", (e) => {
    if (e.key === "Escape" && !box.hidden) set(false);
  });
  return { open: () => set(true), close: () => set(false), isOpen: () => !box.hidden };
}

export function sheets(closeBtn, onChange) {
  let cur = null;
  const apply = (name) => {
    if (cur) document.body.classList.remove("sheet-" + cur);
    cur = name || null;
    if (cur) document.body.classList.add("sheet-" + cur);
    if (closeBtn) closeBtn.hidden = !cur;
    if (onChange) onChange(cur);
  };
  if (closeBtn) on(closeBtn, "click", () => apply(null));
  on(document, "keydown", (e) => {
    if (e.key === "Escape" && cur) apply(null);
  });
  return {
    open: (name) => apply(name),
    close: () => {
      if (cur) apply(null);
    },
    toggle: (name) => apply(cur === name ? null : name),
    current: () => cur,
  };
}

export function rotateHint(okBtn) {
  if (okBtn) on(okBtn, "click", () => document.body.classList.add("rot-ok"));
}

function clearPressed() {
  document.querySelectorAll(".pressed").forEach((el) => el.classList.remove("pressed"));
}

export function pressFeedback(rootEl, selector) {
  if (!rootEl) return;
  on(rootEl, "pointerdown", (e) => {
    const t = e.target.closest ? e.target.closest(selector) : null;
    if (!t || t.disabled) return;
    t.classList.add("pressed");
    if (e.pointerType === "touch") vibrate(8);
  });
  on(rootEl, "pointerup", clearPressed);
  on(rootEl, "pointercancel", clearPressed);
  on(window, "blur", clearPressed);
}

export function guard(rootEl, opts = {}) {
  const reset = () => {
    clearPressed();
    if (opts.onReset) opts.onReset();
  };
  on(rootEl, "contextmenu", (e) => {
    if (state.touch) e.preventDefault();
  });
  on(document, "gesturestart", (e) => e.preventDefault());
  on(rootEl, "touchend", (e) => {
    if (!e.touches || e.touches.length === 0) clearPressed();
  });
  on(rootEl, "touchcancel", reset);
  on(window, "blur", reset);
  on(document, "visibilitychange", () => {
    if (document.hidden) reset();
  });
}

export function destroy() {
  bound.forEach(([el, ev, fn, opt]) => el.removeEventListener(ev, fn, opt));
  bound = [];
  changeCbs = [];
}

export function getState() {
  return state;
}

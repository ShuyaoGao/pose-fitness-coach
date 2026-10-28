# -*- coding: utf-8 -*-
"""手机竖屏 + 电脑尺寸验收（系列规范第八节，v2）。

    python tools/mobile_check_pfc.py                   6 个尺寸全部跑一遍，截图放临时目录
    python tools/mobile_check_pfc.py --shots docs/img  同时把 390×844 的两张截图复制到 docs/img/

用 Playwright 驱动本机已装的 Edge（channel="msedge"），通过 DevTools 协议模拟设备（视口、DPR、mobile、触屏），
不用 --window-size。尺寸：390×844、414×896、360×780（DPR 3）、768×1024（DPR 2）全部开触屏，外加电脑 1920×1080、1366×768。
驱动（tools/mobile_check.py：全机只跑一个 Edge 的锁、空闲内存守卫、横向溢出与 JS 报错检查、截图）随仓库一起分发。

手机场景断言：body 有 touchp；首次打开的说明浮层显示触屏图解（不显示键盘快捷键）、可滚动、「开始」按钮在视口内且 ≥ 44px；
头部一行（标题、标签、☰）；标签 / 大按钮 / 档位按钮 ≥ 44px，标签字号 ≥ 14px；整页不滚动；
回放模式下 tap「开始」后帧数和次数都变化；「换动作」切到开合跳再切回；「回放」从头播；
「看判定依据」全屏打开面板、「返回」关闭；☰ → 操作说明；切到「我来练」（没有摄像头权限）页面照常、整页不滚动；
没有横向溢出；没有 JS 报错。电脑尺寸：没有 touchp、☰ 不显示、右栏并排可见、点击切换模式正常。
摄像头（假设备）的检查在 tools/browser_check.py 里。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "play" / "index.html"
JS_READY = "!!window.__poseCoach"


def _state(page):
    return page.evaluate("window.__poseCoach.state()")


def _small_targets(page, sel, min_h):
    """可见元素里高度低于 min_h 的，返回 'sel#i h=..' 列表。"""
    return page.evaluate(
        """([sel, minH]) => { const out = [];
      document.querySelectorAll(sel).forEach((el, i) => { const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.height < minH - 0.5) out.push(sel + '#' + i + ' h=' + r.height.toFixed(1)); });
      return out; }""",
        [sel, min_h],
    )


def _font_min(page, sel):
    return page.evaluate(
        """(sel) => { let m = 1e9;
      document.querySelectorAll(sel).forEach(el => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return;
        m = Math.min(m, parseFloat(getComputedStyle(el).fontSize)); });
      return m; }""",
        sel,
    )


def _overflow(page, w):
    return page.evaluate(
        """(w) => { const d = document.documentElement, out = [];
      if (d.scrollWidth > w + 1) out.push('document scrollWidth ' + d.scrollWidth + ' > ' + w);
      ['.topbar', '.left', '#mobBar', '#mobScroll', '.right'].forEach(s => { const el = document.querySelector(s);
        if (el && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto') out.push(s + ' scrollWidth ' + el.scrollWidth + ' > ' + el.clientWidth); });
      return out; }""",
        w,
    )


def _page_scrolls(page):
    return page.evaluate("document.documentElement.scrollHeight > innerHeight + 1 || document.body.scrollHeight > innerHeight + 1")


def _hidden(page, el_id):
    return page.evaluate("document.getElementById(%s).classList.contains('hidden')" % json.dumps(el_id))


def scenario(page, size):
    fails = []
    mobile = size["kind"] == "mobile"
    w, h = size["w"], size["h"]
    page.wait_for_function(JS_READY, timeout=60000)
    page.wait_for_timeout(300)

    if not mobile:
        if page.evaluate("document.body.classList.contains('touchp') || document.body.classList.contains('touchl')"):
            fails.append("电脑尺寸却得到 body.touchp / touchl（触屏误判）")
        if _hidden(page, "helpModal"):
            fails.append("电脑：首次打开没有弹出说明")
        else:
            if page.evaluate("getComputedStyle(document.querySelector('.help-touch')).display") != "none":
                fails.append("电脑：说明浮层显示了触屏图解")
            page.click("#helpClose")
            page.wait_for_timeout(200)
        for sel, what in ((".menu-btn", "☰ 菜单按钮"), ("#mobBar", "手机大按钮区"), ("#mobStats", "手机计数区"), ("#rotateHint", "横屏提示")):
            if page.evaluate("getComputedStyle(document.querySelector(%s)).display" % json.dumps(sel)) != "none":
                fails.append("电脑：%s 不该显示" % what)
        if page.evaluate("document.querySelector('.right').getBoundingClientRect().width") < 300:
            fails.append("电脑：右栏没有并排显示")
        page.click(".tab[data-mode=tasks]")
        page.wait_for_timeout(200)
        if _state(page)["mode"] != "tasks":
            fails.append("电脑：点击标签没有切换模式")
        page.click(".tab[data-mode=watch]")
        page.wait_for_timeout(200)
        page.evaluate("window.__poseCoach.seekEnd()")
        page.wait_for_timeout(300)
        st = _state(page)
        if st["count"] != 5 or st["stats"]["good"] != 5:
            fails.append("电脑：「深蹲 · 标准」播完应计 5 次 / 标准 5，实际 %r" % (st["stats"],))
        lay = page.evaluate("""() => { const r = document.querySelector('.right').getBoundingClientRect();
          return {rb: r.bottom, ih: innerHeight, sh: document.querySelector('.stage-wrap').getBoundingClientRect().height}; }""")
        if lay["rb"] > lay["ih"] + 1:
            fails.append("电脑：右栏超出一屏 %r" % (lay,))
        if lay["sh"] < 300:
            fails.append("电脑：主画面高度 < 300px %r" % (lay,))
        fails += _overflow(page, w)
        return fails

    # ---------------- 手机 / 平板竖屏
    if not page.evaluate("document.body.classList.contains('touchp')"):
        fails.append("body 没有 touchp 类")
        return fails
    # 首次打开的说明：触屏图解、无键盘快捷键、可滚动、「开始」在视口内
    if _hidden(page, "helpModal"):
        fails.append("首次打开没有弹出说明")
    else:
        st = page.evaluate(
            """() => ({ touch: getComputedStyle(document.querySelector('.help-touch')).display !== 'none',
              kbd: [...document.querySelectorAll('.kbd-only')].every(e => getComputedStyle(e).display === 'none'),
              scroll: getComputedStyle(document.getElementById('helpBody')).overflowY === 'auto' })"""
        )
        if not st["touch"]:
            fails.append("说明：触屏图解没有显示")
        if not st["kbd"]:
            fails.append("说明：触屏设备上显示了键盘快捷键")
        if not st["scroll"]:
            fails.append("说明：正文不可滚动")
        bb = page.locator("#helpClose").bounding_box()
        if not bb or bb["y"] + bb["height"] > h + 0.5 or bb["height"] < 44:
            fails.append("说明：「开始」按钮不在视口内或太小 %r" % (bb,))
        page.tap("#helpClose")
        page.wait_for_timeout(200)
        if not _hidden(page, "helpModal"):
            fails.append("说明：tap「开始」没有关闭")
    # 头部一行：标题、标签、☰ 都在同一条带里，不超出屏宽
    hd = page.evaluate(
        """() => { const q = s => document.querySelector(s).getBoundingClientRect();
      const top = q('#topbar'); return {b: q('.brand'), t: q('#tabs'), m: q('#menuBtn'), top: {h: top.height, bottom: top.bottom}}; }"""
    )
    for k, name in (("b", "标题"), ("t", "标签"), ("m", "☰")):
        r = hd[k]
        if r["height"] == 0 or r["bottom"] > hd["top"]["bottom"] + 0.5 or r["right"] > w + 0.5:
            fails.append("头部：%s 不在同一行 / 超出屏宽 %r" % (name, r))
    if hd["top"]["h"] > 64:
        fails.append("头部高于一行：%.0f px" % hd["top"]["h"])
    # 触控区与字号
    for sel, mh in ((".tab", 44), ("#menuBtn", 44), ("#mobBar .mbtn", 44), ("#presetBtns button", 44)):
        bad = _small_targets(page, sel, mh)
        if bad:
            fails.append("触控区 < %dpx：%s" % (mh, ", ".join(bad[:4])))
    fm = _font_min(page, ".mbtn, #presetBtns button, .preset-desc, .row label, .clip-note, .ms-verdict")
    if fm < 14:
        fails.append("标签字号 %.1f px < 14 px" % fm)
    # 整页不滚动（所有模式都是一屏）
    if _page_scrolls(page):
        fails.append("看示例：整页还能上下滚动")
    # 核心操作：tap「暂停」→「开始」后帧数前进、次数从 0 变化
    page.tap("#mStart")
    page.wait_for_timeout(150)
    st = _state(page)
    if st["playing"]:
        fails.append("tap「暂停」后仍在播放")
    if "开始" not in page.evaluate("document.getElementById('mStart').textContent"):
        fails.append("暂停后大按钮没有变成「开始」")
    page.evaluate("window.__poseCoach.restart()")
    page.wait_for_timeout(100)
    f0 = _state(page)["frameIdx"]
    c0 = page.evaluate("document.getElementById('mCount').textContent")
    page.tap("#mStart")
    try:
        page.wait_for_function("window.__poseCoach.state().playing && window.__poseCoach.state().frameIdx > %d + 20" % f0, timeout=10000)
        page.wait_for_function("document.getElementById('mCount').textContent !== %s" % json.dumps(c0), timeout=20000)
    except Exception as e:
        fails.append("tap「开始」后帧数 / 次数没有变化：%r（起始帧 %s，起始次数 %s）" % (e, f0, c0))
    # 换动作：深蹲 → 开合跳 → 深蹲
    page.tap("#mSwap")
    page.wait_for_timeout(300)
    st = _state(page)
    if st["exercise"] != "jumpingJack" or "开合跳" not in page.evaluate("document.getElementById('mPhase').textContent"):
        fails.append("tap「换动作」没有切到开合跳：%r" % (st["exercise"],))
    page.tap("#mSwap")
    page.wait_for_timeout(300)
    if _state(page)["exercise"] != "squat":
        fails.append("再 tap「换动作」没有切回深蹲")
    # 回放：从头播
    page.evaluate("window.__poseCoach.seekEnd()")
    page.wait_for_timeout(100)
    page.tap("#mReplay")
    page.wait_for_timeout(200)
    st = _state(page)
    if st["frameIdx"] > 30 or not st["playing"]:
        fails.append("tap「回放」没有从头播放：%r" % ({"frameIdx": st["frameIdx"], "playing": st["playing"]},))
    # 规则引擎面板：默认收起，「看判定依据」全屏，「返回」关闭
    if page.evaluate("document.querySelector('.right').getBoundingClientRect().width") != 0:
        fails.append("手机上右栏应默认收起")
    page.tap("#mPanel")
    page.wait_for_timeout(350)
    rb = page.evaluate(
        """() => { const r = document.querySelector('.right').getBoundingClientRect(); const c = document.getElementById('panelClose').getBoundingClientRect();
      const cv = document.getElementById('curve').getBoundingClientRect();
      return {sheet: document.body.classList.contains('sheet-panel'), pos: getComputedStyle(document.querySelector('.right')).position,
              w: r.width, h: r.height, cy: c.bottom, ch: c.height, curveH: cv.height, verdict: document.getElementById('verdict').textContent.length}; }"""
    )
    if not rb["sheet"] or rb["pos"] != "fixed" or rb["w"] < w - 1 or rb["h"] < h - 1 or rb["cy"] > h + 0.5 or rb["ch"] < 44 or rb["curveH"] < 100 or rb["verdict"] < 10:
        fails.append("「看判定依据」没有全屏打开：%r" % (rb,))
    page.tap("#panelClose")
    page.wait_for_timeout(250)
    if page.evaluate("document.body.classList.contains('sheet-panel') || document.querySelector('.right').getBoundingClientRect().width !== 0"):
        fails.append("「返回」没有关闭面板")
    # ☰ → 操作说明 → 开始
    page.tap("#menuBtn")
    page.wait_for_timeout(150)
    if page.evaluate("document.getElementById('menu').hidden"):
        fails.append("☰ 没有打开菜单")
    page.tap("#menuHelp")
    page.wait_for_timeout(200)
    if _hidden(page, "helpModal") or not page.evaluate("document.getElementById('menu').hidden"):
        fails.append("菜单 → 操作说明 没有打开说明 / 关闭菜单")
    page.tap("#helpClose")
    page.wait_for_timeout(200)
    # 我来练（没有摄像头权限）：页面照常、整页不滚动、大按钮变成「开摄像头」
    page.tap(".tab[data-mode=live]")
    page.wait_for_timeout(300)
    st = _state(page)
    if st["mode"] != "live":
        fails.append("tap「我来练」没有切换模式")
    if "摄像头" not in page.evaluate("document.getElementById('mStart').textContent"):
        fails.append("我来练：大按钮没有变成「开摄像头」")
    if _hidden(page, "stageHint"):
        fails.append("我来练：没有显示开摄像头的提示")
    if _page_scrolls(page):
        fails.append("我来练：整页还能上下滚动")
    fails += _overflow(page, w)
    page.tap("#mReplay")  # 「看示例」
    page.wait_for_timeout(300)
    if _state(page)["mode"] != "watch":
        fails.append("我来练里 tap「看示例」没有切回看示例")
    # 任务模式一屏不滚动
    page.tap(".tab[data-mode=tasks]")
    page.wait_for_timeout(300)
    if page.evaluate("document.querySelectorAll('#taskList li').length") != 7:
        fails.append("任务清单不是 7 项")
    if _page_scrolls(page):
        fails.append("任务：整页还能上下滚动")
    # 回到看示例，播完一段，给截图留一个有内容的画面
    page.tap(".tab[data-mode=watch]")
    page.wait_for_timeout(200)
    page.evaluate("window.__poseCoach.seekEnd()")
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('toast').classList.remove('show')")
    fails += _overflow(page, w)
    return fails


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="把 390×844 的截图（看示例 / 面板打开）复制到这个目录")
    ap.add_argument("--out", help="全部截图 + mobile_check.json 的目录（默认临时目录）")
    args = ap.parse_args(argv)
    sys.path.insert(0, str(ROOT))
    from tools.mobile_check import run  # noqa: E402

    out = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="pfc_mobile_"))
    rep = run(INDEX.as_uri(), out, scenario=scenario, settle_ms=800)
    for s in rep["sizes"]:
        print("%-11s %4dx%-4d dpr%d %s" % (s["name"], s["w"], s["h"], s["dpr"], "PASS" if not s["fails"] else "FAIL: " + " | ".join(s["fails"])))
    print("screenshots:", out)
    if args.shots and rep["ok"]:
        d = Path(args.shots)
        if not d.is_absolute():
            d = ROOT / d
        d.mkdir(parents=True, exist_ok=True)
        src = out / "m390x844.png"
        if src.exists():
            shutil.copy2(src, d / "mobile_390x844.png")
            print("wrote", (d / "mobile_390x844.png").as_posix())
        # 面板打开的那张单独截
        _panel_shot(d / "mobile_panel_390x844.png")
    print(json.dumps({"ok": rep["ok"], "sizes": [(s["name"], not s["fails"]) for s in rep["sizes"]]}))
    return 0 if rep["ok"] else 1


def _panel_shot(path: Path):
    from playwright.sync_api import sync_playwright

    from tools.mobile_check import EdgeLock

    with EdgeLock(), sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        try:
            ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True, locale="zh-CN")
            page = ctx.new_page()
            page.goto(INDEX.as_uri())
            page.wait_for_function(JS_READY, timeout=60000)
            page.wait_for_timeout(300)
            if not _hidden(page, "helpModal"):
                page.tap("#helpClose")
            page.wait_for_timeout(200)
            page.evaluate("window.__poseCoach.seekEnd()")
            page.tap("#mPanel")
            page.wait_for_timeout(500)
            page.screenshot(path=str(path), full_page=False)
            print("wrote", path.as_posix())
        finally:
            b.close()


if __name__ == "__main__":
    raise SystemExit(main())

# -*- coding: utf-8 -*-
"""电脑端端到端验收（1920×1080 和 1366×768）+ 摄像头（假设备）检查 + 截图。

    python tools/browser_check.py                  两种尺寸各跑一遍全部操作，断言没有 JS 报错
    python tools/browser_check.py --shots docs/img 同时把 README 用的截图写到 docs/img/
    python tools/browser_check.py --no-camera      跳过摄像头（假设备）那一段

用 Playwright 驱动本机已装的 Edge（channel="msedge"；不下载浏览器），以 file:// 打开 play/index.html。
摄像头用 Edge 的假设备（--use-fake-device-for-media-stream），画面里没有人，所以只验证
「引擎能在 file:// 下加载、能逐帧检测、没有报错」，不验证识别效果。
全机同一时间只跑一个 Edge：用 tools/mobile_check.py 里的锁排队，空闲内存不足时等待。
手机尺寸的验收在 tools/mobile_check_pfc.py。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "play" / "index.html"
SIZES = [(1920, 1080), (1366, 768)]
CAMERA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, name, cond, extra=""):
        if cond:
            self.passed += 1
            print("  ok  " + name)
        else:
            self.failed += 1
            print("  FAIL " + name + (" " + str(extra)[:400] if extra else ""))


def run_size(browser, w, h, with_camera, shots_dir, ck: Checker):
    print("\n== %dx%d%s" % (w, h, "（含摄像头）" if with_camera else ""))
    ctx = browser.new_context(viewport={"width": w, "height": h}, locale="zh-CN")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
    page.on("console", lambda m: errors.append("console.error: %s" % m.text) if m.type == "error" else None)

    def state():
        return page.evaluate("window.__poseCoach.state()")

    def choose(sel, val):
        page.evaluate("([s, v]) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('change')); }", [sel, val])

    def hidden(el_id):
        return page.evaluate("document.getElementById(%s).classList.contains('hidden')" % json.dumps(el_id))

    def shot(name):
        if not shots_dir:
            return
        shots_dir.mkdir(parents=True, exist_ok=True)
        f = shots_dir / ("%s-%dx%d.png" % (name, w, h))
        page.screenshot(path=str(f), full_page=False)
        print("    截图 → " + (f.relative_to(ROOT).as_posix() if f.is_relative_to(ROOT) else str(f)))

    try:
        page.goto(INDEX.as_uri())
        page.wait_for_function("document.readyState === 'complete' && !!window.__poseCoach", timeout=60000)
        page.wait_for_timeout(300)
        ck.check("页面以 file:// 打开并完成初始化", True)
        ck.check("首次打开弹出操作说明", not hidden("helpModal"))
        ck.check("电脑上不显示触屏图解、显示快捷键", page.evaluate(
            "getComputedStyle(document.querySelector('.help-touch')).display === 'none' && getComputedStyle(document.querySelector('p.kbd-only')).display !== 'none'"))
        shot("01-help")
        page.click("#helpClose")
        page.wait_for_timeout(150)
        ck.check("关闭说明", hidden("helpModal"))
        foot = page.evaluate("document.getElementById('footer').textContent")
        ck.check("页脚有作者署名和联系邮箱", "Shuyao Gao" in foot and "@" in foot, foot)
        ck.check("电脑上没有 touchp、☰ 不显示", page.evaluate(
            "!document.body.classList.contains('touchp') && getComputedStyle(document.getElementById('menuBtn')).display === 'none'"))

        page.wait_for_timeout(2500)
        s = state()
        ck.check("默认进入「看示例」并自动播放", s["mode"] == "watch" and s["playing"] and s["frameIdx"] > 30, s)
        page.evaluate("window.__poseCoach.seekEnd()")
        page.wait_for_timeout(200)
        s = state()
        ck.check("「深蹲 · 标准」计数 5、标准 5（标准档）", s["count"] == 5 and s["stats"]["good"] == 5, s["stats"])
        shot("02-watch")

        page.click('#presetBtns button[data-preset="strict"]')
        page.wait_for_timeout(200)
        s = state()
        ck.check("严格档下同一片段出现「不够深」", s["preset"] == "strict" and "shallow" in (s["lastRep"] or {}).get("cues", []) and s["stats"]["good"] == 0, s["lastRep"])
        shot("03-strict")
        page.click('#presetBtns button[data-preset="standard"]')

        choose("#clipSel", "squat_cropped")
        page.evaluate("window.__poseCoach.seekEnd()")
        s = state()
        ck.check("「脚出了画面」计数 0", s["clipId"] == "squat_cropped" and s["count"] == 0)

        choose("#exerciseSel", "jumpingJack")
        page.evaluate("window.__poseCoach.seekEnd()")
        s = state()
        ck.check("开合跳「标准」计数 6、标准 6", s["exercise"] == "jumpingJack" and s["count"] == 6 and s["stats"]["good"] == 6, s["stats"])
        choose("#clipSel", "jj_arms_low")
        page.evaluate("window.__poseCoach.seekEnd()")
        s = state()
        ck.check("「手没举过头顶」每次都报 arms_low", s["count"] == 5 and "arms_low" in (s["lastRep"] or {}).get("cues", []))

        page.evaluate("""() => { const i = document.querySelector('#sliders input[data-key="fullSpread"]'); i.value = "1.5"; i.dispatchEvent(new Event("input", {bubbles: true})); }""")
        s = state()
        ck.check("拖滑块自动切到「自定义」并重算", s["preset"] == "custom")

        page.click('.tab[data-mode="tasks"]')
        page.wait_for_timeout(200)
        s = state()
        n_tasks = page.evaluate("document.querySelectorAll('#taskList li').length")
        ck.check("「练习任务」显示 7 项清单", s["mode"] == "tasks" and n_tasks == 7)
        n_done = page.evaluate("document.querySelectorAll('#taskList li.done').length")
        ck.check("前面的操作已自动打勾（≥ 3 项）", n_done >= 3, n_done)
        shot("04-tasks")

        page.keyboard.press("h")
        page.wait_for_timeout(100)
        ck.check("按 H 打开说明", not hidden("helpModal"))
        page.keyboard.press("Escape")
        page.click("#bigScreen")
        ck.check("大屏模式开关生效", page.evaluate("document.body.classList.contains('big')"))
        page.click("#bigScreen")

        lay = page.evaluate("""() => { const r = document.querySelector('.right').getBoundingClientRect();
          const st = document.querySelector('.stage-wrap').getBoundingClientRect();
          return { sw: document.documentElement.scrollWidth, iw: innerWidth, rb: r.bottom, ih: innerHeight, sh: st.height }; }""")
        ck.check("无横向滚动", lay["sw"] <= lay["iw"], lay)
        ck.check("右栏完整显示在一屏内", lay["rb"] <= lay["ih"] + 1, lay)
        ck.check("主画面高度 ≥ 300 px", lay["sh"] >= 300, lay)

        if with_camera:
            page.click('.tab[data-mode="live"]')
            page.click("#camBtn")
            ok = False
            try:
                page.wait_for_function("(() => { const s = window.__poseCoach.state(); return s.camOn && s.engine; })()", timeout=60000)
                ok = True
            except Exception as e:  # 超时
                print("    摄像头 / 引擎没有就绪：" + str(e)[:200])
            s = state()
            ck.check("file:// 下加载姿态引擎并打开（假）摄像头", ok, s)
            if ok:
                page.wait_for_timeout(1500)
                s = state()
                print("    推理后端：%s；画布 %dx%d" % (s["engine"], s["stage"]["w"], s["stage"]["h"]))
                ck.check("画布尺寸跟随视频真实尺寸", s["stage"]["w"] > 0 and s["stage"]["h"] > 0, s["stage"])
                shot("05-live")
                page.click('.tab[data-mode="watch"]')
                page.wait_for_timeout(300)
                s = state()
                ck.check("离开「我来练」后摄像头关闭、画布复原 640×480", not s["camOn"] and s["stage"] == {"w": 640, "h": 480}, s["stage"])

        page.click("#exitBtn")
        page.wait_for_timeout(500)
        s = state()
        ck.check("退出：停止运行并显示结束页", s["exited"] and page.evaluate("document.body.textContent.includes('已停止运行')"))
        errors = [e for e in errors if "favicon" not in e.lower()]
        ck.check("全程没有 JS 报错", not errors, "\n      " + "\n      ".join(errors))
    finally:
        ctx.close()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="截图目录（例如 docs/img）")
    ap.add_argument("--no-camera", action="store_true")
    args = ap.parse_args(argv)
    sys.path.insert(0, str(ROOT))
    from playwright.sync_api import sync_playwright

    from tools.mobile_check import EdgeLock

    shots_dir = None
    if args.shots:
        shots_dir = Path(args.shots)
        if not shots_dir.is_absolute():
            shots_dir = ROOT / shots_dir
    ck = Checker()
    with EdgeLock(), sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True, args=CAMERA_ARGS)
        print("browser:", browser.version)
        try:
            for i, (w, h) in enumerate(SIZES):
                run_size(browser, w, h, with_camera=(not args.no_camera and i == len(SIZES) - 1), shots_dir=shots_dir, ck=ck)
        finally:
            browser.close()
    print("\n结果：%d 通过 / %d 失败" % (ck.passed, ck.failed))
    return 0 if ck.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

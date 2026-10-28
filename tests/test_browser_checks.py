# -*- coding: utf-8 -*-
"""浏览器验收（手机 4 个尺寸 + 电脑 2 个尺寸；用本机已装的 Edge，通过 Playwright 驱动）。

    python -m pytest tests/test_browser_checks.py -q      约 1–2 分钟；没有 playwright 或 Edge 时自动跳过

全机同一时间只跑一个 Edge（tools/mobile_check.py 里的锁会排队）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

playwright = pytest.importorskip("playwright.sync_api")


def _edge_available() -> bool:
    try:
        with playwright.sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            b.close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(os.environ.get("SKIP_BROWSER_TESTS") == "1", reason="SKIP_BROWSER_TESTS=1")
def test_mobile_and_desktop_sizes():
    if not _edge_available():
        pytest.skip("本机没有可用的 Edge（Playwright channel msedge）")
    from tools.mobile_check_pfc import main

    assert main([]) == 0

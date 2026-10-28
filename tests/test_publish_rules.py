# -*- coding: utf-8 -*-
"""发布包的静态规则检查（不需要浏览器，几秒跑完）。

    python -m pytest tests/test_publish_rules.py -q

检查 play/ 能在 file:// 下双击运行的技术约束（无 type="module"、无外链、无 fetch 本地文件）、
base64 嵌入的 WASM / 模型与 results/build_info.json 里记的 md5 一致、署名已填、
根目录跳转页和 Release zip 的结构（zip 只在内部目录的 release/ 里有，没有就跳过）。
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PLAY = ROOT / "play"


@pytest.fixture(scope="module")
def build_info():
    return json.loads((ROOT / "results" / "build_info.json").read_text(encoding="utf-8"))


def test_play_index_runs_from_file_url():
    html = (PLAY / "index.html").read_text(encoding="utf-8")
    assert 'type="module"' not in html, "file:// 下 Chrome 会拦 module 脚本"
    assert not re.search(r'(src|href)="https?://', html), "不依赖 CDN / 外链"
    assert "playsinline" in html, "iOS 需要 playsinline 才能内联播放摄像头"
    assert 'content="width=device-width' in html
    for mobile_id in ("menuBtn", "mobBar", "mStart", "mSwap", "mReplay", "mPanel", "panelClose", "rotateHint"):
        assert f'id="{mobile_id}"' in html, mobile_id


def test_play_app_has_no_local_fetch():
    js = (PLAY / "app.js").read_text(encoding="utf-8")
    # 引擎文件走 <script> 加载的 base64；允许对 blob: / data: 的 fetch（WASM 实例化），不允许读相对路径文件
    assert not re.search(r'fetch\(\s*["\'](\./|\.\./|/|engine/)', js)
    assert "touchp" in js and "sheet-panel" in js or "sheet-" in js


def test_embedded_wasm_and_model_match_build_info(build_info):
    for rel, key in [("play/engine/wasm_b64.js", "wasm"), ("play/engine/model_b64.js", "model")]:
        text = (ROOT / rel).read_text(encoding="utf-8")
        payload = re.search(r'="([A-Za-z0-9+/=]+)";', text).group(1)
        raw = base64.b64decode(payload)
        assert len(raw) == build_info["sources"][key]["bytes"], rel
        assert hashlib.md5(raw).hexdigest() == build_info["sources"][key]["md5"], rel


def test_credits_filled_in_play():
    credits = (PLAY / "credits.js").read_text(encoding="utf-8")
    assert "{{" not in credits
    assert '"AUTHOR": "Shuyao Gao"' in credits
    assert '"AUTHOR_EMAIL": "gaoshuyao.mk@gmail.com"' in credits
    notices = (PLAY / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
    assert "Copyright (c) 2026 Shuyao Gao" in notices


def test_root_redirect_page():
    cands = [ROOT / "publish_templates" / "index.html", ROOT / "index.html"]
    idx = next((c for c in cands if c.exists()), None)
    assert idx is not None, "根目录跳转页缺失（publish_templates/index.html 或 ./index.html）"
    html = idx.read_text(encoding="utf-8")
    assert 'http-equiv="refresh"' in html and "url=play/index.html" in html
    assert 'href="play/index.html"' in html, "要有可点的后备链接"


def test_release_zip_layout(build_info):
    rel = build_info.get("release")
    zips = sorted((ROOT / "release").glob("*.zip")) if (ROOT / "release").exists() else []
    if not zips:
        pytest.skip("没有 release/*.zip（公开仓库里 zip 不进 git）")
    z = zipfile.ZipFile(zips[-1])
    names = z.namelist()
    top = names[0].split("/")[0]
    assert f"{top}/index.html" in names, "zip 里要有根目录的跳转页，解压后双击 index.html 才成立"
    assert f"{top}/play/index.html" in names
    assert all(n.startswith(top + "/") for n in names)
    html = z.read(f"{top}/index.html").decode("utf-8")
    assert "{{" not in html and "url=play/index.html" in html
    assert len(names) == rel["files"]
    assert zips[-1].stat().st_size <= 15 * 1024 * 1024
    for info in z.infolist():
        assert info.flag_bits & 0x800 or info.filename.isascii(), "非 ASCII 文件名要带 UTF-8 标记"

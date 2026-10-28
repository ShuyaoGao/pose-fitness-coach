"""把 credits.json 里的署名、系列名、用户名、仓库名一次性填进所有文档，并同步网页包里的署名。

    python tools/fill_credits.py            填充占位并更新 play/credits.js、play/THIRD_PARTY_NOTICES.txt
    python tools/fill_credits.py --check    只检查还剩哪些 {{占位}}，不改文件

占位写成 {{KEY}}，KEY 是 credits.json 里的字段名。值为空的字段（例如可选的 UNIVERSITY_LOGO）不算缺失。
网页包 play/ 的署名来自 play/credits.js（由本脚本或 tools/build_play.mjs 从 credits.json 生成），
所以改署名不需要重新打包 app.js。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {".md", ".cff", ".txt", ".html", ".json"}
TEXT_NAMES = {"LICENSE", "LICENSE-docs"}
SKIP_DIRS = {".git", "node_modules", "release"}
PLACEHOLDER = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def read(p: Path) -> str:
    with open(p, encoding="utf-8", newline="") as f:  # 保留原换行符
        return f.read()


def write(p: Path, s: str) -> None:
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def text_files():
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file() or any(part in SKIP_DIRS for part in p.relative_to(ROOT).parts):
            continue
        if p.name == "credits.json" or p.name.startswith("_"):
            continue
        if p.suffix in TEXT_SUFFIXES or p.name in TEXT_NAMES:
            yield p


def write_play_credits(credits: dict) -> None:
    play = ROOT / "play"
    if not play.is_dir():
        return
    write(
        play / "credits.js",
        "// 由 credits.json 生成（tools/build_play.mjs / tools/fill_credits.py），请勿手改。\n"
        f"window.CREDITS = {json.dumps(credits, ensure_ascii=False, indent=2)};\n",
    )
    notices = play / "THIRD_PARTY_NOTICES.txt"
    if notices.exists():
        s = read(notices)
        s = re.sub(r"Copyright \(c\) \d{4} [^。\n]+。", f"Copyright (c) {credits['YEAR']} {credits['AUTHOR']}。", s, count=1)
        write(notices, s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    credits = json.loads((ROOT / "credits.json").read_text(encoding="utf-8"))

    missing: dict[str, list[str]] = {}
    changed = 0
    for p in text_files():
        s = read(p)

        def sub(m: re.Match) -> str:
            key = m.group(1)
            val = credits.get(key)
            if val is None or val == "":
                missing.setdefault(key, []).append(p.relative_to(ROOT).as_posix())
                return m.group(0)
            return str(val)

        new = PLACEHOLDER.sub(sub, s)
        if new != s and not a.check:
            write(p, new)
            changed += 1
    if not a.check:
        write_play_credits(credits)
        print(f"已填充 {changed} 个文件，并更新 play/credits.js")
    if missing:
        print("仍有占位没有值：")
        for k, files in missing.items():
            print(f"  {{{{{k}}}}}：{', '.join(sorted(set(files)))}")
        return 1
    print("没有剩余占位。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

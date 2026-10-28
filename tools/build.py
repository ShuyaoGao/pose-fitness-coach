"""一条命令构建发布包。

    python tools/build.py              构建 play/ 并重算 results/result.json
    python tools/build.py --release    另外打包 release/<仓库名>-v<版本>.zip（play/ + 根目录的跳转页 index.html）

需要先 npm install（用到 node_modules 里的 vite 和 @mediapipe/tasks-vision）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP_LIMIT = 15 * 1024 * 1024  # 发布 zip ≤ 15 MB


def run(cmd: list[str]) -> None:
    print("$", " ".join(cmd))
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    subprocess.run(cmd, cwd=ROOT, check=True, env=env, shell=(os.name == "nt"))


def make_zip(credits: dict) -> Path:
    name = f"{credits['REPO_NAME']}-v{credits['VERSION']}"
    out = ROOT / "release" / f"{name}.zip"
    out.parent.mkdir(exist_ok=True)
    play = ROOT / "play"
    entries = [(f"play/{p.relative_to(play).as_posix()}", p) for p in sorted(play.rglob("*")) if p.is_file()]
    # 根目录的跳转页（meta refresh → play/index.html）也放进 zip，这样“解压后双击 index.html”成立。
    # 公开仓库里它就是根目录的 index.html；内部开发目录里在 publish_templates/。
    idx = next((c for c in [ROOT / "publish_templates" / "index.html", ROOT / "index.html"] if c.exists()), None)
    if idx is None:
        raise SystemExit("找不到根目录跳转页 index.html（publish_templates/index.html 或 ./index.html）")
    entries.insert(0, ("index.html", idx))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, p in entries:
            info = zipfile.ZipInfo(f"{name}/{rel}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            data = p.read_bytes()
            if rel == "index.html":
                # 模板里的 {{占位}} 用 credits.json 填好再打包
                text = data.decode("utf-8")
                for k, v in credits.items():
                    text = text.replace("{{" + k + "}}", str(v))
                data = text.encode("utf-8")
            z.writestr(info, data, compresslevel=9)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", action="store_true", help="同时打包 release zip")
    ap.add_argument("--credits", default=str(ROOT / "credits.json"))
    a = ap.parse_args()
    credits = json.loads(Path(a.credits).read_text(encoding="utf-8"))

    run(["node", "tools/build_play.mjs", "--credits", a.credits])
    run(["node", "tools/replay_report.mjs"])

    info_path = ROOT / "results" / "build_info.json"
    info = json.loads(info_path.read_text(encoding="utf-8"))
    if a.release:
        z = make_zip(credits)
        size = z.stat().st_size
        info["release"] = {"file": f"release/{z.name}", "bytes": size, "files": len(zipfile.ZipFile(z).namelist())}
        info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"release zip：{z.relative_to(ROOT).as_posix()}  {size / 1e6:.2f} MB")
        if size > ZIP_LIMIT:
            print("✗ zip 超过 15 MB 上限", file=sys.stderr)
            return 1
    print(f"play/ 合计 {info['play_total_bytes'] / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

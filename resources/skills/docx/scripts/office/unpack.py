"""Unpack an Office file (.docx/.pptx/.xlsx and templates) into a folder, safely.

Infraon addition (not part of the upstream skill). Works the same in PowerShell, cmd and bash, unlike unzip/zip:

    python scripts/office/unpack.py doc.docx unpacked

Office files from other people are untrusted: entries with absolute paths, drive letters or ".." are refused, and
symlink entries are skipped, so nothing can be written outside the target folder.
"""

import argparse
import os
import stat
import sys
import zipfile
from pathlib import Path


def unpack(src: Path, dest: Path, force: bool = False) -> int:
    if dest.exists() and any(dest.iterdir()) and not force:
        raise SystemExit(f"{dest} is not empty; pass --force to unpack over it")
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    count = 0
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir():
                continue
            if stat.S_ISLNK(info.external_attr >> 16):
                print(f"skipped symlink entry: {name}", file=sys.stderr)
                continue
            if name.startswith("/") or ":" in name.split("/")[0] or ".." in name.split("/"):
                raise SystemExit(f"refusing unsafe entry: {name}")
            target = (root / name).resolve()
            if os.path.commonpath([str(root), str(target)]) != str(root):
                raise SystemExit(f"refusing unsafe entry: {name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as fin, open(target, "wb") as fout:
                while True:
                    chunk = fin.read(1 << 20)
                    if not chunk:
                        break
                    fout.write(chunk)
            count += 1
    return count


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", type=Path)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--force", action="store_true", help="unpack into a folder that is not empty")
    a = ap.parse_args()
    if not zipfile.is_zipfile(a.file):
        raise SystemExit(f"{a.file} is not an Office (ZIP) file; legacy .doc/.ppt/.xls must be converted first")
    n = unpack(a.file, a.folder, a.force)
    print(f"unpacked {n} files into {a.folder.resolve()}")


if __name__ == "__main__":
    main()

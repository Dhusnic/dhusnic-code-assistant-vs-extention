"""Pack an unpacked Office folder back into a .docx/.pptx/.xlsx, or clean an existing file's folder entries.

Infraon addition (not part of the upstream skill). Works the same in PowerShell, cmd and bash, unlike zip:

    python scripts/office/pack.py unpacked out.docx     # folder -> Office file
    python scripts/office/pack.py --clean output.docx   # drop ZIP folder entries in place

[Content_Types].xml is written first, entries are deflated, folder entries and symlinks are left out (Word has refused
files with folder entries when opened through cloud co-editing), and file contents are copied byte for byte, so XML
you edited is never reformatted.
"""

import argparse
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

FIRST = "[Content_Types].xml"


def _ordered(names):
    names = sorted(names)
    return ([FIRST] if FIRST in names else []) + [n for n in names if n != FIRST]


def pack(folder: Path, out: Path) -> int:
    if not (folder / FIRST).is_file():
        raise SystemExit(f"{folder} has no {FIRST}: is it an unpacked Office file?")
    files = []
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        for f in filenames:
            p = Path(dirpath) / f
            if p.is_symlink():
                continue
            files.append(p.relative_to(folder).as_posix())
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name in _ordered(files):
            z.write(folder / name, name)
    os.replace(tmp, out)
    return len(files)


def clean(path: Path) -> int:
    with zipfile.ZipFile(path) as z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        dropped = len(z.infolist()) - len(infos)
        if not dropped:
            return 0
        fd, tmp = tempfile.mkstemp(suffix=path.suffix, dir=str(path.parent))
        os.close(fd)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            by_name = {i.filename: i for i in infos}
            for name in _ordered(by_name):
                info = by_name[name]
                entry = zipfile.ZipInfo(info.filename, info.date_time)
                entry.compress_type = zipfile.ZIP_DEFLATED
                with z.open(info) as src, out.open(entry, "w") as dst:
                    shutil.copyfileobj(src, dst)
    os.replace(tmp, path)
    return dropped


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--clean", type=Path, metavar="FILE", help="remove folder entries from an existing Office file")
    ap.add_argument("folder", type=Path, nargs="?")
    ap.add_argument("out", type=Path, nargs="?")
    a = ap.parse_args()
    if a.clean:
        print(f"removed {clean(a.clean)} folder entries from {a.clean.resolve()}")
        return
    if not a.folder or not a.out:
        ap.error("give FOLDER and OUT, or --clean FILE")
    n = pack(a.folder, a.out)
    print(f"packed {n} files into {a.out.resolve()}")


if __name__ == "__main__":
    main()

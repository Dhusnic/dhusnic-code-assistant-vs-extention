"""Append an approved memory import to an Infraon memory file. Additive only: existing lines are never changed.

    python scripts/append_memory.py <draft.md> --source "ChatGPT"                 # -> ~/.infraon/INFRAON.md
    python scripts/append_memory.py <draft.md> --source "ChatGPT" --target <file> # another memory file

The draft is a Markdown file of "- " bullet lines (headings allowed) that the user approved. Lines already present in
the target (ignoring case and surrounding spaces) are skipped, everything else goes under a dated
"## Imported from <source>" heading at the end of the file. The draft is deleted afterwards unless --keep is given,
so the export does not linger in the workspace.
"""

import argparse
import datetime
import os
import re
from pathlib import Path

MAX_DRAFT_BYTES = 64 * 1024


def norm(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip().lstrip("-*").strip()).lower()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("draft", type=Path)
    ap.add_argument("--source", required=True, help='where the memories came from, e.g. "ChatGPT"')
    ap.add_argument("--target", type=Path, default=Path.home() / ".infraon" / "INFRAON.md")
    ap.add_argument("--keep", action="store_true", help="keep the draft file")
    a = ap.parse_args()

    if a.draft.stat().st_size > MAX_DRAFT_BYTES:
        raise SystemExit("The draft is larger than 64 KB: memory is loaded into every request, so import a shorter summary.")
    draft = a.draft.read_text(encoding="utf-8").replace("\r\n", "\n").splitlines()
    target = a.target.expanduser()
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    seen = {norm(l) for l in existing.splitlines() if l.strip()}

    keep, skipped = [], 0
    for line in draft:
        if not line.strip():
            if keep and keep[-1] != "":
                keep.append("")
            continue
        if line.lstrip().startswith("#"):
            keep.append("###" + line.lstrip().lstrip("#") if not line.lstrip().startswith("###") else line.strip())
            continue
        if norm(line) in seen:
            skipped += 1
            continue
        seen.add(norm(line))
        keep.append(line.rstrip())
    bullets = [l for l in keep if l.lstrip().startswith(("-", "*"))]
    if not bullets:
        print(f"Nothing new to add ({skipped} line(s) were already in {target}).")
    else:
        source = re.sub(r"[\r\n#]", " ", a.source).strip()[:60] or "another assistant"
        header = f"## Imported from {source} ({datetime.date.today().isoformat()})"
        block = "\n".join([header, "", *keep]).rstrip() + "\n"
        target.parent.mkdir(parents=True, exist_ok=True)
        sep = "" if not existing.strip() else ("\n" if existing.endswith("\n") else "\n\n")
        with open(target, "a", encoding="utf-8", newline="\n") as f:
            f.write(sep + block)
        print(f"Added {len(bullets)} line(s) to {target}" + (f"; skipped {skipped} already present." if skipped else "."))
    if not a.keep:
        os.remove(a.draft)


if __name__ == "__main__":
    main()

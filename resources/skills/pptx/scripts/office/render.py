"""Render a document to page images so you can look at them (with the view_image tool).

Infraon addition (not part of the upstream skill). One command on every OS and shell:

    python scripts/office/render.py output.docx            # .docx .pptx .xlsx .odt ... or a .pdf
    python scripts/office/render.py deck.pptx --dpi 150 --pages 1-3

Office files go to PDF through LibreOffice (scripts/office/soffice.py), then each page becomes a JPEG with pdftoppm
(Poppler), or pypdfium2 / PyMuPDF when Poppler is not installed. Images land in a fresh folder under the system temp
directory (named infraon-render-*), old images from earlier runs of the same file are removed, and the absolute
path of every image is printed, one per line, ready to pass to view_image.
"""

import argparse
import hashlib
import importlib.util
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from office.soffice import run_soffice  # noqa: E402


def to_pdf(src: Path, work: Path, timeout: int) -> Path:
    if src.suffix.lower() == ".pdf":
        return src
    r = run_soffice(["--headless", "--convert-to", "pdf", "--outdir", str(work), str(src)],
                    capture_output=True, text=True, timeout=timeout)
    pdf = work / (src.stem + ".pdf")
    if r.returncode != 0 or not pdf.exists():
        detail = (r.stderr or r.stdout or "").strip()
        raise SystemExit(f"PDF conversion failed{': ' + detail if detail else ''}")
    return pdf


def page_range(spec, count):
    if not spec:
        return 1, count
    a, _, b = spec.partition("-")
    first = max(1, int(a))
    last = min(count, int(b)) if b else (first if not _ else count)
    return first, last


def with_pdftoppm(exe, pdf, out, dpi, pages):
    args = [exe, "-jpeg", "-r", str(dpi)]
    if pages:
        a, _, b = pages.partition("-")
        args += ["-f", a] + (["-l", b] if b else ([] if _ else ["-l", a]))
    subprocess.run(args + [str(pdf), str(out / "page")], check=True, capture_output=True)


def with_pdfium(pdf, out, dpi, pages):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf))
    first, last = page_range(pages, len(doc))
    width = len(str(len(doc)))
    for i in range(first - 1, last):
        doc[i].render(scale=dpi / 72).to_pil().convert("RGB").save(out / f"page-{str(i + 1).zfill(width)}.jpg", quality=85)


def with_pymupdf(pdf, out, dpi, pages):
    import fitz
    doc = fitz.open(str(pdf))
    first, last = page_range(pages, doc.page_count)
    width = len(str(doc.page_count))
    for i in range(first - 1, last):
        doc[i].get_pixmap(dpi=dpi).save(str(out / f"page-{str(i + 1).zfill(width)}.jpg"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", type=Path)
    ap.add_argument("--dpi", type=int, default=100)
    ap.add_argument("--pages", help="e.g. 2 or 1-3 (default: all)")
    ap.add_argument("--out", type=Path, help="folder for the images (default: a temp folder for this file)")
    ap.add_argument("--timeout", type=int, default=180, help="seconds allowed for the LibreOffice conversion")
    a = ap.parse_args()
    src = a.file.resolve()
    if not src.is_file():
        raise SystemExit(f"no such file: {src}")
    tag = hashlib.sha1(str(src).lower().encode()).hexdigest()[:8]
    out = (a.out or Path(tempfile.gettempdir()) / f"infraon-render-{src.stem[:40]}-{tag}").resolve()
    out.mkdir(parents=True, exist_ok=True)
    for old in list(out.glob("page-*.jpg")) + list(out.glob("*.pdf")):
        if old.resolve() != src:
            old.unlink()

    try:
        pdf = to_pdf(src, out, a.timeout)
    except ModuleNotFoundError as e:
        raise SystemExit(f"missing Python package '{e.name}': run  {Path(sys.executable).name} -m pip install {e.name}")
    except FileNotFoundError as e:
        raise SystemExit(str(e))
    except subprocess.TimeoutExpired:
        raise SystemExit(f"LibreOffice did not finish within {a.timeout}s; retry with --timeout 600")
    exe = shutil.which("pdftoppm")
    if exe:
        with_pdftoppm(exe, pdf, out, a.dpi, a.pages)
    elif importlib.util.find_spec("pypdfium2"):
        with_pdfium(pdf, out, a.dpi, a.pages)
    elif importlib.util.find_spec("fitz"):
        with_pymupdf(pdf, out, a.dpi, a.pages)
    else:
        raise SystemExit("No PDF rasterizer: install Poppler (pdftoppm) or run: python -m pip install pypdfium2")

    images = sorted(out.glob("page-*.jpg"))
    if not images:
        raise SystemExit("rendering produced no images")
    print(f"pdf: {pdf}")
    for img in images:
        print(img)


if __name__ == "__main__":
    main()

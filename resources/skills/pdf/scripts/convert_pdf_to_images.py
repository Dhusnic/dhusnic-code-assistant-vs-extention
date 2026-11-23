import os
import sys

# Infraon patch: Poppler (needed by pdf2image) is rarely installed on Windows, so pypdfium2 is tried as well, and the
# output folder is created when missing.


def _pages(pdf_path, dpi):
    try:
        from pdf2image import convert_from_path
        return convert_from_path(pdf_path, dpi=dpi)
    except Exception as first:  # ImportError, or pdf2image's PDFInfoNotInstalledError when Poppler is missing
        try:
            import pypdfium2 as pdfium
        except ImportError:
            raise SystemExit(f"Cannot render the PDF ({first}). Install Poppler, or run: python -m pip install pypdfium2")
        doc = pdfium.PdfDocument(pdf_path)
        return [doc[i].render(scale=dpi / 72).to_pil() for i in range(len(doc))]


def convert(pdf_path, output_dir, max_dim=1000):
    os.makedirs(output_dir, exist_ok=True)
    images = _pages(pdf_path, 200)

    for i, image in enumerate(images):
        width, height = image.size
        if width > max_dim or height > max_dim:
            scale_factor = min(max_dim / width, max_dim / height)
            new_width = int(width * scale_factor)
            new_height = int(height * scale_factor)
            image = image.resize((new_width, new_height))

        image_path = os.path.abspath(os.path.join(output_dir, f"page_{i+1}.png"))
        image.save(image_path)
        print(f"Saved page {i+1} as {image_path} (size: {image.size})")

    print(f"Converted {len(images)} pages to PNG images")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: convert_pdf_to_images.py [input pdf] [output directory]")
        sys.exit(1)
    pdf_path = sys.argv[1]
    output_directory = sys.argv[2]
    convert(pdf_path, output_directory)

"""Crop a region of an image (zoom in on a form field). Infraon addition: replaces ImageMagick, which is often missing.

    python scripts/crop_image.py <image> <x> <y> <width> <height> <output.png>

x, y is the top-left corner in pixels; the crop keeps the original scale (1 crop pixel = 1 image pixel), so a
position measured in the crop maps back to the full image by adding x and y.
"""

import os
import sys

from PIL import Image


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit(__doc__)
    src, out = sys.argv[1], sys.argv[6]
    x, y, w, h = (int(v) for v in sys.argv[2:6])
    img = Image.open(src)
    box = (max(0, x), max(0, y), min(img.width, x + w), min(img.height, y + h))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.crop(box).save(out)
    print(f"{os.path.abspath(out)}: region {box} of a {img.width}x{img.height} image")


if __name__ == "__main__":
    main()

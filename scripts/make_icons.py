"""Resize icons/icon.png into the three sizes Chrome needs.

Trims transparent padding from the source so the artwork fills the toolbar
slot (Chrome renders the file at its native pixel size, so empty alpha
around the art makes the icon look small next to icons that reach the edge).

Produces icons/icon16.png, icons/icon48.png, icons/icon128.png.
Run with: python3 scripts/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
SOURCE = ICON_DIR / "icon.png"
SIZES = (16, 48, 128)

# Faint pixels below this alpha are treated as transparent when finding the
# artwork bbox. Without a threshold a single 1-alpha pixel anywhere in the
# canvas defeats the crop.
ALPHA_THRESHOLD = 30

# Padding (as a fraction of the final canvas) kept inside the tight crop. Set
# to 0 for edge-to-edge in the toolbar.
INNER_PADDING_RATIO = 0.0

# "fill" picks the SHORTER bbox dimension as the square side (the long axis
# gets cropped — maximum render size in the toolbar). "fit" picks the LONGER
# dimension (no cropping — the artwork is fully visible but leaves transparent
# bars on the short axis, which makes the icon look smaller).
SQUARE_MODE = "fill"


def tight_square(img: Image.Image) -> Image.Image:
    """Crop transparent padding and produce a square canvas of the artwork."""
    alpha = img.split()[-1]
    mask = alpha.point(lambda a: 255 if a > ALPHA_THRESHOLD else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return img
    cropped = img.crop(bbox)
    cw, ch = cropped.size
    side = min(cw, ch) if SQUARE_MODE == "fill" else max(cw, ch)
    canvas_side = max(1, int(round(side / (1 - 2 * INNER_PADDING_RATIO))))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    # Center the artwork on the square. When SQUARE_MODE=="fill" this means
    # the long axis is cropped symmetrically; "fit" leaves transparent margins.
    canvas.paste(cropped, ((canvas_side - cw) // 2, (canvas_side - ch) // 2))
    return canvas


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(
            f"Source icon not found at {SOURCE}. Drop a square PNG there first."
        )
    src = Image.open(SOURCE).convert("RGBA")
    squared = tight_square(src)
    print(f"source {src.size} → tight-square {squared.size}")
    for size in SIZES:
        out = squared.resize((size, size), Image.LANCZOS)
        path = ICON_DIR / f"icon{size}.png"
        out.save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()

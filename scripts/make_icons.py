"""Generate simple placeholder icons for the TripAnchor Chrome extension.

Produces icons/icon16.png, icons/icon48.png, icons/icon128.png.
Run with: python3 scripts/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
ICON_DIR.mkdir(exist_ok=True)

BG = (24, 99, 175)       # ocean blue
PIN = (255, 255, 255)    # white pin
DOT = (24, 99, 175)      # inner dot matches bg


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = max(1, size // 16)
    radius = max(2, size // 5)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=BG)

    cx = size / 2
    head_r = size * 0.22
    head_top = size * 0.22
    head_bottom = head_top + head_r * 2
    d.ellipse(
        [cx - head_r, head_top, cx + head_r, head_bottom],
        fill=PIN,
    )

    tip_y = size * 0.82
    tail_w = head_r * 0.9
    d.polygon(
        [
            (cx - tail_w, head_bottom - head_r * 0.4),
            (cx + tail_w, head_bottom - head_r * 0.4),
            (cx, tip_y),
        ],
        fill=PIN,
    )

    dot_r = head_r * 0.42
    dot_cy = head_top + head_r
    d.ellipse(
        [cx - dot_r, dot_cy - dot_r, cx + dot_r, dot_cy + dot_r],
        fill=DOT,
    )

    return img


def main() -> None:
    for size in (16, 48, 128):
        path = ICON_DIR / f"icon{size}.png"
        draw_icon(size).save(path, "PNG")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()

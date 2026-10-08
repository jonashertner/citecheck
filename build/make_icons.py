#!/usr/bin/env python3
"""Draw the add-in's icons (needs Pillow): a page margin with a check mark for the cite
check, and lines of text with one word covered for the anonymization check."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "addin" / "assets"
BLUE, WHITE = (31, 79, 216, 255), (255, 255, 255, 255)


def icon(size: int) -> Image.Image:
    s = size * 4                                   # supersample, then reduce
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.19, fill=BLUE)
    w = max(2, round(s * 0.085))
    d.line((s * 0.27, s * 0.2, s * 0.27, s * 0.8), fill=(255, 255, 255, 120), width=max(1, w // 2))      # the margin rule
    d.line((s * 0.40, s * 0.53, s * 0.53, s * 0.67, s * 0.78, s * 0.34), fill=WHITE, width=w, joint="curve")
    for x, y in ((s * 0.40, s * 0.53), (s * 0.78, s * 0.34)):
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def anon_icon(size: int) -> Image.Image:
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.19, fill=BLUE)
    w = max(2, round(s * 0.085))
    d.line((s * 0.27, s * 0.2, s * 0.27, s * 0.8), fill=(255, 255, 255, 120), width=max(1, w // 2))      # the margin rule
    thin = max(2, round(s * 0.05))
    faint = (255, 255, 255, 150)
    d.line((s * 0.40, s * 0.33, s * 0.78, s * 0.33), fill=faint, width=thin)                              # a line of text
    d.line((s * 0.40, s * 0.50, s * 0.49, s * 0.50), fill=faint, width=thin)                              # a word, then
    d.rounded_rectangle((s * 0.54, s * 0.50 - w * 0.9, s * 0.80, s * 0.50 + w * 0.9), radius=w * 0.35, fill=WHITE)  # the covered one
    d.line((s * 0.40, s * 0.67, s * 0.68, s * 0.67), fill=faint, width=thin)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 64, 80, 128):
        icon(size).save(OUT / f"icon-{size}.png", optimize=True)
        anon_icon(size).save(OUT / f"anon-{size}.png", optimize=True)
        print(OUT / f"icon-{size}.png", OUT / f"anon-{size}.png")

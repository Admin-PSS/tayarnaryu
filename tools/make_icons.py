"""Draw the app icon (a Dhamma wheel) as PNGs for the PWA manifest."""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
BG, FG = (139, 69, 19), (244, 196, 98)  # brown, saffron


def wheel(size, pad_ratio):
    s = size * 4  # supersample
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    c = s / 2
    r = s * (0.5 - pad_ratio)
    w = max(2, int(r * 0.09))
    d.ellipse([c - r, c - r, c + r, c + r], outline=FG, width=w)          # rim
    hub = r * 0.2
    d.ellipse([c - hub, c - hub, c + hub, c + hub], outline=FG, width=w)  # hub
    for k in range(8):                                                    # 8 spokes
        a = k * math.pi / 4
        x1, y1 = c + hub * math.cos(a), c + hub * math.sin(a)
        x2, y2 = c + (r - w / 2) * math.cos(a), c + (r - w / 2) * math.sin(a)
        d.line([x1, y1, x2, y2], fill=FG, width=int(w * 0.8))
        kx, ky, kr = c + (r + w * 0.9) * math.cos(a), c + (r + w * 0.9) * math.sin(a), w * 0.9
        d.ellipse([kx - kr, ky - kr, kx + kr, ky + kr], fill=FG)          # rim knobs
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size in (192, 512):
    wheel(size, 0.16).save(OUT / f"icon-{size}.png")
wheel(512, 0.26).save(OUT / "maskable-512.png")   # extra safe zone for Android masks
wheel(180, 0.16).save(OUT / "apple-touch-icon.png")
print("icons ->", OUT)

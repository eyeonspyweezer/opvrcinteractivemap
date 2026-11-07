#!/usr/bin/env python3
"""
tools/build_map_regions.py
Splits the full map image into 6 region images:
- 2 Top Regions (Left/Right)
- 2 Middle Regions (Left/Right) - Exactly 105px tall & vertically centered
- 2 Bottom Regions (Left/Right)
"""

from pathlib import Path
from PIL import Image

MAP_IMAGE_PATH = Path("map.png")  # Path to your master map image
OUT_DIR = Path("botimg-test/regions")

def generate_regions():
    if not MAP_IMAGE_PATH.exists():
        print(f"Error: {MAP_IMAGE_PATH} not found.")
        return

    img = Image.open(MAP_IMAGE_PATH).convert("RGBA")
    W, H = img.size

    # --- Vertical Math ---
    MID_HEIGHT = 105
    mid_top = int((H - MID_HEIGHT) / 2)
    mid_bottom = mid_top + MID_HEIGHT

    # --- Horizontal Math ---
    mid_x = int(W / 2)

    # 6 Region Coordinates (left, upper, right, lower)
    regions = {
        "top-left":     (0,     0,          mid_x, mid_top),
        "top-right":    (mid_x, 0,          W,     mid_top),
        "mid-left":     (0,     mid_top,    mid_x, mid_bottom),
        "mid-right":    (mid_x, mid_top,    W,     mid_bottom),
        "bot-left":     (0,     mid_bottom, mid_x, H),
        "bot-right":    (mid_x, mid_bottom, W,     H),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for region_name, box in regions.items():
        cropped = img.crop(box)
        out_path = OUT_DIR / f"{region_name}.png"
        cropped.save(out_path, optimize=True)
        print(f"Saved region: {out_path} ({cropped.width}x{cropped.height}px)")

if __name__ == "__main__":
    generate_regions()

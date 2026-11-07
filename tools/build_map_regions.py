#!/usr/bin/env python3
"""
tools/build_map_regions.py
--------------------------
Splits the full map image (map.png) into 6 region images for the /map command.
"""

from pathlib import Path
from PIL import Image

MAP_IMAGE_PATH = Path("map.png")
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

    # Coordinates match your Cloudflare Worker Region IDs perfectly
    regions = {
        "nblue":    (0,     0,          mid_x, mid_top),     # North Blue (Top-Left)
        "eblue":    (mid_x, 0,          W,     mid_top),     # East Blue (Top-Right)
        "paradise": (0,     mid_top,    mid_x, mid_bottom),  # Paradise (Mid-Left)
        "newworld": (mid_x, mid_top,    W,     mid_bottom),  # New World (Mid-Right)
        "wblue":    (0,     mid_bottom, mid_x, H),          # West Blue (Bot-Left)
        "sblue":    (mid_x, mid_bottom, W,     H),          # South Blue (Bot-Right)
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for region_name, box in regions.items():
        cropped = img.crop(box)
        out_path = OUT_DIR / f"{region_name}.png"
        cropped.save(out_path, optimize=True)
        print(f"Saved region: {out_path} ({cropped.width}x{cropped.height}px)")

if __name__ == "__main__":
    generate_regions()

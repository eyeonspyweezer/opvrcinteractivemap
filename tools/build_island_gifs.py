import argparse
import csv
import hashlib
import json
import math
import shutil
from datetime import date
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ... [Keep your previous constants] ...
OUT_ROOT = Path("botimg-test/islandgifs")
CURRENT = OUT_ROOT / "current"
ARCHIVE = OUT_ROOT / "archive"
BG_DIR = Path("island-backgrounds") # Where sync_sheets.py saves images

def create_gif(flag_img: Image.Image, island_name: str, out_path: Path, island_id: str):
    island_name = label_text(island_name)
    raw = flag_img.convert("RGBA")
    
    # NEW: Try to load the island's specific background image
    bg_image = None
    bg_path = BG_DIR / f"{slug(island_name)}.jpg"
    if bg_path.exists():
        bg_image = Image.open(bg_path).convert("RGBA")
        bg_image = bg_image.resize((CANVAS_W, CANVAS_H), Image.LANCZOS)

    flag = prepare_flag(raw, max_w=FLAG_AREA_W - 20, max_h=CANVAS_H - 28)
    rgba_frames = []
    
    for i in range(FRAMES):
        phase = (i / FRAMES) * 2 * math.pi
        
        # Background logic
        if bg_image:
            frame = bg_image.copy()
            # Add a slight dark overlay to keep text readable
            overlay = Image.new("RGBA", frame.size, (0, 0, 0, 100))
            frame.alpha_composite(overlay)
        else:
            # Fallback to the sampled color logic
            bg_rgb = sample_bg_color(raw)
            card_bg = (max(18, min(50, bg_rgb[0]//5 + 22)), max(18, min(50, bg_rgb[1]//5 + 22)), max(20, min(55, bg_rgb[2]//5 + 26)))
            frame = Image.new("RGBA", (CANVAS_W, CANVAS_H), (*card_bg, 255))
        
        draw = ImageDraw.Draw(frame)
        # ... [Rest of waving flag drawing logic stays the same] ...
        
        # Drawing flag and text
        waved = make_waved_flag(flag, phase)
        fx, fy = PAD + 6, (CANVAS_H - waved.height) // 2
        frame.paste(waved, (fx, fy), waved)
        
        # ... [Draw your lines and text here] ...
        rgba_frames.append(frame)

    # Save logic...
    # [Rest of create_gif remains standard]

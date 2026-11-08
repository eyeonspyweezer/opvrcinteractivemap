#!/usr/bin/env python3
"""
tools/build_island_gifs.py
--------------------------
Waving-flag island cards with optional custom island backgrounds.
Archives old versions to preserve map history when ownership or flags change.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CANVAS_W, CANVAS_H = 720, 180
FRAMES = 24
DURATION_MS = 70
WAVE_AMPLITUDE = 9.0
WAVE_LENGTH = 0.55
FLAG_AREA_W = 260
PAD = 28

# --- DEBUG FONT LOADER ---
ROOT_DIR = Path(__file__).parent.parent
FONT_PATH = ROOT_DIR / "one piece font.ttf"  # Update this string if your filename uses hyphens instead of spaces (e.g. "one-piece-font.ttf")
FALLBACK_FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

print(f"DEBUG: Looking for custom font at: {FONT_PATH.absolute()}")
if FONT_PATH.exists():
    print(f"SUCCESS: Found custom font! File size: {FONT_PATH.stat().st_size} bytes")
else:
    print(f"ERROR: Custom font NOT found at {FONT_PATH.absolute()}")
    print("Files currently in root folder:")
    for f in ROOT_DIR.iterdir():
        print(f" - {f.name}")

if not FONT_PATH.exists():
    if FALLBACK_FONT.exists():
        print("Falling back to system font.")
        FONT_PATH = FALLBACK_FONT
    else:
        raise FileNotFoundError(f"Custom font not found at {FONT_PATH} and fallback is missing!")

USING_CUSTOM_FONT = FONT_PATH.name in ("one piece font.ttf", "one-piece-font.ttf")


OUT_ROOT = Path("botimg-test/islandgifs")
CURRENT = OUT_ROOT / "current"
ARCHIVE = OUT_ROOT / "archive"
BG_DIR = Path("island-backgrounds")
MANIFEST = OUT_ROOT / "manifest.json"


def slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-") or "unknown"


def sample_bg_color(img: Image.Image) -> tuple[int, int, int]:
    img = img.convert("RGBA")
    w, h = img.size
    border = max(2, min(w, h) // 25)
    samples = []
    for x in range(0, w, max(1, w // 40)):
        for y in list(range(0, border)) + list(range(h - border, h)):
            p = img.getpixel((x, y))
            if p[3] > 180:
                samples.append(p[:3])
    if not samples:
        return (28, 30, 34)
    return max(set(samples), key=samples.count)


def prepare_flag(flag: Image.Image, max_w: int, max_h: int) -> Image.Image:
    flag = flag.convert("RGBA")
    fw, fh = flag.size
    scale = min(max_w / fw, max_h / fh)
    return flag.resize((max(1, int(fw * scale)), max(1, int(fh * scale))), Image.LANCZOS)


def wave_offset(u: float, v: float, phase: float) -> tuple[float, float]:
    edge = u ** 1.25
    weight = max(0.12, edge)
    dx = math.sin(phase + u * (2.2 * WAVE_LENGTH) + v * 1.1) * WAVE_AMPLITUDE * weight
    dx += math.sin(phase * 1.6 + u * (4.0 * WAVE_LENGTH) + v * 2.4) * (WAVE_AMPLITUDE * 0.28 * weight)
    dy = math.sin(phase * 0.85 + u * 1.6 + v * 2.8) * (WAVE_AMPLITUDE * 0.32 * weight)
    return dx, dy


def make_waved_flag(flag: Image.Image, phase: float) -> Image.Image:
    fw, fh = flag.size
    pad = int(WAVE_AMPLITUDE) + 4
    out = Image.new("RGBA", (fw + pad * 2, fh + pad * 2), (0, 0, 0, 0))
    src, dst = flag.load(), out.load()
    for y in range(fh):
        v = y / max(1, fh - 1)
        for x in range(fw):
            u = x / max(1, fw - 1)
            offx, offy = wave_offset(u, v, phase)
            ix, iy = int(round(x - offx)), int(round(y - offy))
            if 0 <= ix < fw and 0 <= iy < fh:
                p = src[ix, iy]
                if p[3] > 12:
                    dst[x + pad, y + pad] = p
    return out


def draw_outlined_text(draw, pos, text, font, fill=(255, 255, 255), outline=(0, 0, 0), ow=4):
    x, y = pos
    for ox in range(-ow, ow + 1):
        for oy in range(-ow, ow + 1):
            if ox or oy:
                draw.text((x + ox, y + oy), text, font=font, fill=outline)
    draw.text((x, y), text, font=font, fill=fill)


def fit_text(draw, text, font_path, max_width, start=72, minimum=24):
    size = start
    while size >= minimum:
        font = ImageFont.truetype(str(font_path), size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return ImageFont.truetype(str(font_path), minimum)


def archive_if_exists(dest: Path, crew_slug: str, island_slug: str):
    """Moves existing GIF into the archive folder to preserve map history."""
    if not dest.exists():
        return
    month = date.today().strftime("%Y-%m")
    day = date.today().isoformat()
    arch_dir = ARCHIVE / month
    arch_dir.mkdir(parents=True, exist_ok=True)
    target = arch_dir / f"{crew_slug}__{island_slug}__{day}.gif"
    n = 1
    while target.exists():
        target = arch_dir / f"{crew_slug}__{island_slug}__{day}_{n}.gif"
        n += 1
    shutil.move(str(dest), str(target))
    print(f"    archived old map state → {target}")


def create_gif(flag_imgs: list[Image.Image], island_name: str, out_path: Path):
    raw_flags = [f.convert("RGBA") for f in flag_imgs]
    flag_count = len(raw_flags)

    # Reserve a separate space for every organization's flag.
    flag_gap = 8
    flag_region_width = FLAG_AREA_W + 26
    slot_width = (flag_region_width - flag_gap * (flag_count - 1)) // flag_count

    flags = [
        prepare_flag(
            f,
            max_w=max(1, slot_width - 26),
            max_h=CANVAS_H - 28
        )
        for f in raw_flags
    ]

    # Check if a custom background exists.
    bg_image = None
    base_slug = slug(island_name)

    for ext in (".webp", ".png", ".jpg", ".jpeg"):
        bg_path = BG_DIR / f"{base_slug}{ext}"
        if bg_path.exists():
            try:
                bg = Image.open(bg_path).convert("RGBA")

                img_w, img_h = bg.size
                scale = max(CANVAS_W / img_w, CANVAS_H / img_h)
                new_w, new_h = int(img_w * scale), int(img_h * scale)
                bg = bg.resize((new_w, new_h), Image.LANCZOS)

                left = (new_w - CANVAS_W) // 2
                top = (new_h - CANVAS_H) // 2
                bg_image = bg.crop(
                    (left, top, left + CANVAS_W, top + CANVAS_H)
                )

                dark = Image.new(
                    "RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 110)
                )
                bg_image = Image.alpha_composite(bg_image, dark)
                break
            except Exception as e:
                print(f"Warning: Failed to load background {bg_path}: {e}")
                break

    rgba_frames = []

    for i in range(FRAMES):
        phase = (i / FRAMES) * 2 * math.pi

        if bg_image:
            frame = bg_image.copy()
        else:
            bg_rgb = sample_bg_color(raw_flags[0])
            card_bg = (
                max(18, min(50, bg_rgb[0] // 5 + 22)),
                max(18, min(50, bg_rgb[1] // 5 + 22)),
                max(20, min(55, bg_rgb[2] // 5 + 26))
            )
            frame = Image.new(
                "RGBA", (CANVAS_W, CANVAS_H), (*card_bg, 255)
            )

        draw = ImageDraw.Draw(frame)

        fx = PAD + 6

        # Animate every flag independently.
        for flag_index, flag in enumerate(flags):
            waved = make_waved_flag(flag, phase)

            slot_x = fx + flag_index * (slot_width + flag_gap)
            flag_x = slot_x + (slot_width - waved.width) // 2
            flag_y = (CANVAS_H - waved.height) // 2

            frame.paste(waved, (flag_x, flag_y), waved)

        div_x = fx + flag_region_width + 18
        draw.line(
            [(div_x, 24), (div_x, CANVAS_H - 24)],
            fill=(200, 200, 200, 150),
            width=2
        )

        if FONT_PATH.exists():
            text_left = div_x + 22
            text_max_w = CANVAS_W - text_left - PAD
            lbl = island_name.upper()
            font = fit_text(draw, lbl, FONT_PATH, max_width=text_max_w)

            bbox = draw.textbbox((0, 0), lbl, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]

            tx = text_left + (text_max_w - tw) // 2 - bbox[0]
            ty = (CANVAS_H - th) // 2 - bbox[1]

            draw_outlined_text(draw, (tx, ty), lbl, font)

        rgba_frames.append(frame)

    rgba_frames.append(rgba_frames[0].copy())

    palette_src = Image.new("RGBA", (CANVAS_W, CANVAS_H * 2))
    palette_src.paste(rgba_frames[0], (0, 0))
    palette_src.paste(rgba_frames[FRAMES // 2], (0, CANVAS_H))
    palette_src = palette_src.convert("RGB").quantize(colors=256)

    quantized = [
        fr.convert("RGB").quantize(
            palette=palette_src,
            dither=Image.Dither.NONE
        )
        for fr in rgba_frames
    ]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        out_path,
        save_all=True,
        append_images=quantized[1:],
        duration=DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2
    )


def read_tsv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return list(csv.DictReader(path.open(encoding="utf-8"), delimiter="\t"))


def load_flag_for_island(
    island: dict,
    groups: dict,
    atlas: Image.Image | None,
    crew_flag_dirs: list
) -> list[Image.Image]:

    g_ids = [
        island.get(k)
        for k in ("Group1", "Group2", "Group3")
        if island.get(k) and island.get(k) != "0"
    ]

    found_flags = []

    for gid in g_ids:
        g = groups.get(gid)
        if not g:
            continue

        name = g.get("Group", "")
        flag_img = None

        # Check custom crew flag folder.
        for folder in crew_flag_dirs:
            for ext in (".webp", ".png", ".jpg", ".gif"):
                for candidate in (
                    folder / f"{slug(name)}{ext}",
                    folder / f"{name.lower().replace(' ', '')}{ext}"
                ):
                    if candidate.exists():
                        flag_img = Image.open(candidate).convert("RGBA")
                        break
                if flag_img:
                    break
            if flag_img:
                break

        # Fall back to atlas.
        if flag_img is None and atlas is not None:
            try:
                cell = int(g.get("Flag", -1))
                if cell >= 0:
                    ATLAS_CELL, ATLAS_COLS = 128, 16
                    x = (cell % ATLAS_COLS) * ATLAS_CELL
                    y = (cell // ATLAS_COLS) * ATLAS_CELL
                    flag_img = atlas.crop(
                        (x, y, x + ATLAS_CELL, y + ATLAS_CELL)
                    ).convert("RGBA")
            except (ValueError, TypeError):
                pass

        if flag_img:
            found_flags.append(flag_img)

    # Use the island's own flag only if no organization flags were found.
    if not found_flags and atlas is not None:
        try:
            cell = int(island.get("Flag", -1))
            if cell >= 0:
                ATLAS_CELL, ATLAS_COLS = 128, 16
                x = (cell % ATLAS_COLS) * ATLAS_CELL
                y = (cell // ATLAS_COLS) * ATLAS_CELL
                found_flags.append(
                    atlas.crop(
                        (x, y, x + ATLAS_CELL, y + ATLAS_CELL)
                    ).convert("RGBA")
                )
        except (ValueError, TypeError):
            pass

    return found_flags


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Only build this island name / slug")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    islands = read_tsv(Path("island-colors.tsv"))
    groups = {g["ID"]: g for g in read_tsv(Path("island-groups.tsv"))}
    atlas = Image.open("island-flags.png").convert("RGBA") if Path("island-flags.png").exists() else None
    crew_flag_dirs = [Path("crewflags")]

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    made = 0
    for isl in islands:
        name = (isl.get("Island Name") or "").strip()
        if not name or isl.get("Unknown") == "1":
            continue
        if args.only and args.only.lower() not in (name.lower(), slug(name)):
            continue

        crew_name = "unowned"
        for key in ("Group1", "Group2", "Group3"):
            g = groups.get(isl.get(key, ""))
            if g and g.get("Group"):
                crew_name = g["Group"]
                break
        crew_s, island_s = slug(crew_name), slug(name)
        dest = CURRENT / crew_s / f"{island_s}.gif"

        flags = load_flag_for_island(isl, groups, atlas, crew_flag_dirs)
        if not flags:
            continue
        
        flag_data = b"".join(
            str(f.size).encode() + b":" + f.convert("RGBA").tobytes()
            for f in flags
        )
        
        sig = hashlib.sha1(
            (name + "|" + crew_s).encode() + flag_data
        ).hexdigest()[:20]
        old = manifest.get(island_s)
        if old and old.get("sig") == sig and dest.exists() and not args.force:
            continue

        if old and old.get("crew") != crew_s:
            archive_if_exists(CURRENT / old["crew"] / f"{island_s}.gif", old["crew"], island_s)
        archive_if_exists(dest, crew_s, island_s)
        
        print(f"  building {crew_s}/{island_s}.gif")
        create_gif(flags, name, dest)
        manifest[island_s] = {"crew": crew_s, "sig": sig}
        made += 1

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=1, sort_keys=True))
    print(f"\nDone – {made} GIF(s) processed in {CURRENT}")


if __name__ == "__main__":
    main()

# tools/build_island_cards.py   (TEST - used only by /islandtest)
# Makes one card picture per island: flag on the left, island name, owner, group, "since" date.
# Output: botimg-test/islandtest/<island ID>.png  (the workflow publishes it to the bot-images-test branch)
#
# Change the look here: FONT_BOLD / FONT_REGULAR (path to a .ttf), the colors, CARD_W / CARD_H.

import csv, os
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = os.environ.get("CARD_FONT_BOLD", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
FONT_REGULAR = os.environ.get("CARD_FONT_REGULAR", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")

CARD_W, CARD_H = 900, 300
BG = (30, 31, 34)
TEXT = (255, 255, 255)
SOFT = (219, 222, 225)
FAINT = (160, 165, 172)
ATLAS_CELL, ATLAS_COLS = 128, 16     # island-flags.png: 16 x 16 cells of 128 px
FLAG_H = 200
OUT = Path("botimg-test/islandtest")


def read_tsv(path):
    p = Path(path)
    if not p.exists():
        return []
    return list(csv.DictReader(open(p, encoding="utf-8"), delimiter="\t"))


def as_int(v, default=-1):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def accent_color(island):
    first = (island.get("Color") or "#005aff").split()[0].lstrip("#")
    try:
        rgb = tuple(int(first[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        rgb = (0, 90, 255)
    if sum(rgb) < 120:                      # black pirates would vanish on a dark card
        rgb = (107, 111, 118)
    return rgb


def fit_font(draw, text, path, start, max_width, minimum=26):
    size = start
    while size > minimum:
        font = ImageFont.truetype(path, size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return ImageFont.truetype(path, minimum)


def clip(draw, text, font, max_width):
    if draw.textlength(text, font=font) <= max_width:
        return text
    while text and draw.textlength(text + "...", font=font) > max_width:
        text = text[:-1]
    return text + "..."


def since_text(row, unowned=False):
    try:
        d = datetime.strptime(row["Since"], "%Y-%m-%d")
    except (KeyError, ValueError):
        return ""
    when = f"{d.strftime('%B')} {d.day}, {d.year}"
    start = "Unowned since" if unowned else "Same owner since"
    return f"{start} {'at least ' if row.get('AtLeast') == '1' else ''}{when}"


def main():
    islands = read_tsv("island-colors.tsv")
    groups = {g["ID"]: g for g in read_tsv("island-groups.tsv")}
    since = {r["Island Name"]: r for r in read_tsv("island-since.tsv")}
    atlas = Image.open("island-flags.png").convert("RGBA") if Path("island-flags.png").exists() else None

    def flag_image(island):
        """Island's own flag, else the first group flag. Cut out of the flag atlas."""
        candidates = [(as_int(island.get("Flag")), as_int(island.get("FlagAspect"), 50))]
        for key in ("Group1", "Group2", "Group3"):
            g = groups.get(island.get(key, ""))
            if g:
                candidates.append((as_int(g.get("Flag")), as_int(g.get("FlagAspect"), 50)))
        for cell, aspect in candidates:
            if cell >= 0 and atlas is not None and aspect > 0:
                x, y = (cell % ATLAS_COLS) * ATLAS_CELL, (cell // ATLAS_COLS) * ATLAS_CELL
                im = atlas.crop((x, y, x + ATLAS_CELL, y + ATLAS_CELL))
                width = max(60, min(300, round(FLAG_H * aspect / 50)))
                return im.resize((width, FLAG_H), Image.LANCZOS)
        return None

    OUT.mkdir(parents=True, exist_ok=True)
    made = 0
    for isl in islands:
        name = (isl.get("Island Name") or "").strip()
        if not name or isl.get("Unknown") == "1":
            continue

        img = Image.new("RGB", (CARD_W, CARD_H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, 13, CARD_H], fill=accent_color(isl))

        text_x = 48
        flag = flag_image(isl)
        if flag is not None:
            top = (CARD_H - FLAG_H) // 2
            img.paste(flag, (36, top), flag)
            d.rectangle([36, top, 36 + flag.width - 1, top + FLAG_H - 1], outline=(70, 72, 78), width=2)
            text_x = 36 + flag.width + 30
        max_w = CARD_W - text_x - 30

        owner = "Unowned" if isl.get("Unowned") == "1" else (isl.get("Owner") or "").strip() or "-"
        group_names = [groups[g]["Group"] for g in (isl.get("Group1"), isl.get("Group2"), isl.get("Group3"))
                       if g in groups]
        lines = [("Owner: " + owner, SOFT)]
        if group_names:
            lines.append(("Group: " + ", ".join(group_names), SOFT))
        s = since.get(name)
        text = since_text(s, isl.get("Unowned") == "1") if s else ""
        if text:
            lines.append((text, FAINT))

        d.text((text_x, 38), clip(d, name, fit_font(d, name, FONT_BOLD, 52, max_w), max_w),
               font=fit_font(d, name, FONT_BOLD, 52, max_w), fill=TEXT)
        font = ImageFont.truetype(FONT_REGULAR, 28)
        y = 120
        for text, color in lines[:3]:
            d.text((text_x, y), clip(d, text, font, max_w), font=font, fill=color)
            y += 48

        img.save(OUT / f"{isl['ID']}.png", optimize=True)
        made += 1
    print(f"Made {made} island cards in {OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
tools/sync_sheets.py
--------------------
Copies background pictures and owner links from Google Sheets into the repo.
1) Island pictures ("Visual" column) -> island-backgrounds/<island-name>.jpg
2) Owner info ("Owner(s)", "Profile Link", "Discord ID") -> owner-links.tsv
"""

import csv
import io
import json
import re
import urllib.request
from pathlib import Path
from PIL import Image

ISLAND_SHEET = "127a13tHpfFMfhPDUWw16nX9i5u4Qrn1GL-kcFxL5GIE"
OWNER_SHEET = "17N7e8tQkzWsbGQdD1wDuNvj3eYkPyl_anvkrbRBOV5I"
GID = 0

BG_DIR = Path("island-backgrounds")
BG_MANIFEST = BG_DIR / "manifest.json"
OWNER_FILE = Path("owner-links.tsv")

NAME_HEADERS = ("island / location", "island/location", "location", "island", "name")
OWNER_HEADERS = ("owner(s)", "owner", "owners")
SEPARATORS = re.compile(r"[\/,&]")
MAX_DOWNLOAD = 8 * 1024 * 1024
BG_MAX_SIDE = 960


def slug(s):
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-") or "unknown"


def norm_key(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "opvrc-sheet-sync"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(MAX_DOWNLOAD + 1)


def download_bytes(url):
    data = _get(url)
    if len(data) > MAX_DOWNLOAD:
        raise ValueError("picture is bigger than 8 MB")
    return data


def fetch_tsv(sheet_id):
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=tsv&gid={GID}"
    text = _get(url).decode("utf-8", errors="replace")
    return list(csv.reader(io.StringIO(text), delimiter="\t"))


def sync_backgrounds():
    rows = fetch_tsv(ISLAND_SHEET)
    manifest = json.loads(BG_MANIFEST.read_text()) if BG_MANIFEST.exists() else {}
    name_col = vis_col = None
    saved = skipped = failed = 0

    for row in rows:
        cells = [c.strip() for c in row]
        low = [c.lower() for c in cells]
        if "visual" in low:
            vis_col = low.index("visual")
            name_col = next((i for i, c in enumerate(low) if c in NAME_HEADERS), 0)
            continue
        if vis_col is None or len(cells) <= vis_col or name_col >= len(cells):
            continue
        name = cells[name_col]
        m = re.search(r"https?://[^\s\"')]+", cells[vis_col])
        key = norm_key(name)
        if not name or not key or not m:
            continue

        url = m.group(0)
        base = url.split("?")[0]
        entry = manifest.get(key)
        if entry and entry.get("url") == base and (BG_DIR / entry["file"]).exists():
            skipped += 1
            continue

        fname = f"{slug(name)}.webp"
        try:
            img = Image.open(io.BytesIO(download_bytes(url)))
            img.seek(0)
            img = img.convert("RGB")
            img.thumbnail((BG_MAX_SIDE, BG_MAX_SIDE))
            BG_DIR.mkdir(exist_ok=True)
            img.save(BG_DIR / fname, "WEBP", quality=80)
            manifest[key] = {"name": name, "url": base, "file": fname}
            saved += 1
            print(f"  saved background: {fname}")
        except Exception as e:
            failed += 1
            kept = " (kept existing picture)" if entry and (BG_DIR / entry["file"]).exists() else ""
            print(f"  FAILED {name}: {e}{kept}")

    if manifest:
        BG_DIR.mkdir(exist_ok=True)
        BG_MANIFEST.write_text(json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False))
    print(f"Island pictures: {saved} saved, {skipped} already saved, {failed} failed")


def sync_owner_links():
    rows = fetch_tsv(OWNER_SHEET)
    cols = None
    owners = {}

    for row in rows:
        low = [c.strip().lower() for c in row]
        if "profile link" in low or "discord id" in low:
            cols = {
                "owner": next((i for i, c in enumerate(low) if c in OWNER_HEADERS), 0),
                "link": low.index("profile link") if "profile link" in low else None,
                "id": low.index("discord id") if "discord id" in low else None,
            }
            continue
        if cols is None:
            continue

        def cell(i):
            return row[i].strip() if i is not None and i < len(row) else ""

        link = cell(cols["link"])
        if not link.lower().startswith("https://"):
            link = ""
        did = re.sub(r"\D", "", cell(cols["id"]))
        if not (17 <= len(did) <= 20):
            did = ""
        if not link and not did:
            continue
        for name in SEPARATORS.split(cell(cols["owner"])):
            name = name.strip()
            key = norm_key(name)
            if not key:
                continue
            old = owners.get(key)
            if old is None or (not old[1] and link) or (not old[2] and did):
                owners[key] = (name, link or (old[1] if old else ""), did or (old[2] if old else ""))

    lines = ["Owner\tProfile Link\tDiscord ID"]
    for name, link, did in sorted(owners.values(), key=lambda x: x[0].lower()):
        lines.append(f"{name}\t{link}\t{did}")
    text = "\n".join(lines) + "\n"
    if not OWNER_FILE.exists() or OWNER_FILE.read_text(encoding="utf-8") != text:
        OWNER_FILE.write_text(text, encoding="utf-8")
    print(f"Owner links: {len(owners)} owners written to {OWNER_FILE}")


CREW_SHEET = "1IcCHc-ERXwUGyJmyDChw5MXwShDeGDNqkCr7fIafoDk"
CREW_FILE = Path("crew-links.tsv")

CREW_FIELDS = {
    "vrchat_group_url": ("vrchat group url", "vrchat url", "vrc group url", "vrchat group link", "vrc group link"),
    "vrchat_group_id": ("vrchat group id", "vrc group id", "group id"),
    "discord_invite": ("discord invite", "discord invite url", "discord url", "discord server invite", "invite link"),
    "vrchat_members": ("vrchat members", "vrc members", "total vrchat members", "group members", "total members"),
    "vrchat_online": ("vrchat online", "vrc online", "vrchat online members", "online members", "members online"),
    "discord_members": ("discord members", "discord server members", "discord member count", "server members"),
}

def sync_crew_metadata():
    rows = fetch_tsv(CREW_SHEET)
    header_index = None
    columns = {}
    for i, row in enumerate(rows):
        low = [re.sub(r"\\s+", " ", c.strip().lower()) for c in row]
        if low and low[0] in ("crews/groups", "nations", "nation"):
            header_index = i
            for field, aliases in CREW_FIELDS.items():
                columns[field] = next((j for j, value in enumerate(low) if value in aliases), None)
            break

    if header_index is None:
        raise ValueError("Could not find the Crews/Groups header row in the crew spreadsheet.")

    def cell(row, index):
        return row[index].strip() if index is not None and index < len(row) else ""

    lines = ["Group\\tVRChatGroupURL\\tVRChatGroupID\\tDiscordInvite\\tVRChatMembers\\tVRChatOnline\\tDiscordMembers"]
    for row in rows[header_index + 1:]:
        name = cell(row, 0)
        if not name:
            continue
        values = [name] + [cell(row, columns[field]) for field in CREW_FIELDS]
        lines.append("\\t".join(value.replace("\\t", " ").replace("\\r", " ").replace("\\n", " ") for value in values))

    output = "\\n".join(lines) + "\\n"
    if not CREW_FILE.exists() or CREW_FILE.read_text(encoding="utf-8") != output:
        CREW_FILE.write_text(output, encoding="utf-8")
    print(f"Crew metadata: {len(lines) - 1} groups written to {CREW_FILE}; detected columns: " +
          ", ".join(key for key, index in columns.items() if index is not None))

def main():
    for step in (sync_backgrounds, sync_owner_links, sync_crew_metadata):
        try:
            step()
        except Exception as e:
            print(f"{step.__name__} failed: {e}")


if __name__ == "__main__":
    main()

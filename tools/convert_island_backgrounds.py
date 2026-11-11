#!/usr/bin/env python3
"""Convert every raster image in island-backgrounds to real WebP files."""
import json
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path("island-backgrounds")
MANIFEST = ROOT / "manifest.json"
QUALITY = 88

def main():
    if not ROOT.is_dir():
        raise SystemExit("island-backgrounds folder was not found")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    changed = {}
    converted = removed = 0

    for source in sorted(ROOT.iterdir()):
        if not source.is_file() or source.name == MANIFEST.name or source.suffix.lower() == ".webp":
            continue
        try:
            with Image.open(source) as opened:
                opened.seek(0)
                image = ImageOps.exif_transpose(opened)
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                target = source.with_suffix(".webp")
                image.save(target, "WEBP", quality=QUALITY, method=6)
            with Image.open(target) as check:
                if check.format != "WEBP":
                    raise RuntimeError(f"Verification failed: {target} is not WebP")
            changed[source.name] = target.name
            converted += 1
            print(f"Converted {source.name} -> {target.name}")
        except Exception as exc:
            raise RuntimeError(f"Could not convert {source.name}: {exc}") from exc

    if changed:
        for entry in manifest.values():
            filename = entry.get("file") if isinstance(entry, dict) else None
            if filename in changed:
                entry["file"] = changed[filename]
        MANIFEST.write_text(json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

        # Delete old files only after every conversion and manifest update succeeded.
        for old_name in changed:
            (ROOT / old_name).unlink()
            removed += 1

    # Verify that every image file left in the folder is encoded as WebP.
    invalid = []
    for path in ROOT.iterdir():
        if not path.is_file() or path.name == MANIFEST.name:
            continue
        try:
            with Image.open(path) as image:
                if image.format != "WEBP":
                    invalid.append(path.name)
        except Exception:
            invalid.append(path.name)
    if invalid:
        raise RuntimeError("Non-WebP or unreadable files remain: " + ", ".join(invalid))
    print(f"Finished: {converted} converted, {removed} originals removed. All island backgrounds are WebP.")

if __name__ == "__main__":
    main()

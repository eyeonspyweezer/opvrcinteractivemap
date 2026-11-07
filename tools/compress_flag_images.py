#!/usr/bin/env python3
"""Compress oversized community flag images in place, preserving file names and formats."""

from pathlib import Path
from PIL import Image, ImageOps
import io
import sys

TARGET = 950 * 1024  # stay safely below Discord's 1 MB limit
DIRECTORIES = [Path("flags"), Path("crewflags"), Path("crew-flags")]
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def encode(image, fmt, quality, optimize=True):
    buffer = io.BytesIO()
    if fmt == "JPEG":
        if image.mode not in ("RGB", "L"):
            background = Image.new("RGB", image.size, "white")
            if "A" in image.getbands():
                background.paste(image, mask=image.getchannel("A"))
            else:
                background.paste(image.convert("RGB"))
            image = background
        image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    elif fmt == "WEBP":
        image.save(buffer, format="WEBP", quality=quality, method=6)
    elif fmt == "PNG":
        candidate = image
        if candidate.mode not in ("RGB", "RGBA", "P", "L", "LA"):
            candidate = candidate.convert("RGBA" if "A" in candidate.getbands() else "RGB")
        # Community flags are usually graphic artwork; palette compression keeps transparency.
        if candidate.mode in ("RGBA", "RGB"):
            method = Image.Quantize.FASTOCTREE if candidate.mode == "RGBA" else Image.Quantize.MEDIANCUT
            candidate = candidate.quantize(colors=256, method=method)
        candidate.save(buffer, format="PNG", optimize=True, compress_level=9)
    else:
        image.save(buffer, format=fmt, optimize=optimize)
    return buffer.getvalue()


def optimize(path):
    original = path.stat().st_size
    if original <= TARGET:
        return False

    with Image.open(path) as source:
        source.seek(0)
        image = ImageOps.exif_transpose(source).copy()
        fmt = (source.format or path.suffix.lstrip(".")).upper()
        if fmt == "JPG":
            fmt = "JPEG"
        if fmt not in {"PNG", "JPEG", "WEBP"}:
            print(f"Skipping unsupported format: {path}")
            return False

    best = None
    # Reduce quality first for lossy formats; reduce dimensions progressively if needed.
    for scale in (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4):
        if scale == 1.0:
            resized = image
        else:
            size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
            resized = image.resize(size, Image.Resampling.LANCZOS)
        qualities = (88, 82, 76, 70, 64, 58) if fmt in {"JPEG", "WEBP"} else (90,)
        for quality in qualities:
            data = encode(resized, fmt, quality)
            best = data
            if len(data) <= TARGET:
                path.write_bytes(data)
                print(f"Compressed {path}: {original:,} -> {len(data):,} bytes ({resized.width}x{resized.height})")
                return True

    if best and len(best) < original:
        path.write_bytes(best)
        print(f"Reduced {path}: {original:,} -> {len(best):,} bytes; still above target")
        return True

    print(f"Could not reduce {path} below target; original kept")
    return False


def main():
    changed = 0
    for directory in DIRECTORIES:
        if not directory.exists():
            continue
        for path in directory.rglob("*"):
            if path.is_file() and path.suffix.lower() in EXTENSIONS:
                try:
                    changed += int(optimize(path))
                except Exception as exc:
                    print(f"Could not process {path}: {exc}", file=sys.stderr)
    print(f"Optimized {changed} image(s).")


if __name__ == "__main__":
    main()

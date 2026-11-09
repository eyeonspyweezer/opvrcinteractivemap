#!/usr/bin/env python3
"""Refresh live player counts for every VRChat world linked on the OPVRC map."""

import csv
import datetime as dt
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(".")
SOURCE = ROOT / "island-colors.tsv"
OUTPUT = ROOT / "island-world-populations.tsv"
WORLD_RE = re.compile(
    r"wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)
API = "https://api.vrchat.cloud/api/1/worlds/{}"
USER_AGENT = "OPVRCMapBot/1.1 (live public world population; github.com/eyeonspyweezer/opvrcinteractivemap)"
REQUEST_GAP_SECONDS = 2.0


def read_tsv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def write_tsv(rows):
    headers = [
        "World ID", "World Name", "Total Players", "Public Players",
        "Private Players", "Checked At UTC", "Status",
    ]
    with OUTPUT.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=headers, delimiter="\t", lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(rows)


def fetch_world(world_id):
    request = urllib.request.Request(
        API.format(world_id),
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )

    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                data = json.loads(response.read().decode("utf-8"))

            values = []
            for key in ("occupants", "publicOccupants", "privateOccupants"):
                value = data.get(key)
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    return None, str(data.get("name") or ""), "population_unavailable"
                values.append(value)

            return {
                "World ID": world_id,
                "World Name": str(data.get("name") or world_id),
                "Total Players": values[0],
                "Public Players": values[1],
                "Private Players": values[2],
            }, "", "ok"

        except urllib.error.HTTPError as exc:
            if (exc.code == 429 or 500 <= exc.code < 600) and attempt < 3:
                retry_after = exc.headers.get("Retry-After", "")
                try:
                    wait = min(180, max(10, int(retry_after))) if retry_after else 20 * (attempt + 1)
                except ValueError:
                    wait = 20 * (attempt + 1)
                print(f"{world_id}: HTTP {exc.code}; retrying in {wait}s")
                time.sleep(wait)
                continue
            return None, "", f"http_{exc.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            if attempt < 3:
                wait = 10 * (attempt + 1)
                print(f"{world_id}: {exc}; retrying in {wait}s")
                time.sleep(wait)
                continue
            return None, "", "request_failed"

    return None, "", "request_failed"


def main():
    if not SOURCE.exists():
        raise SystemExit("Missing island-colors.tsv")

    world_ids = set()
    for island in read_tsv(SOURCE):
        links = " ".join((island.get("Link") or "", island.get("WorldId") or ""))
        world_ids.update(match.group(0).lower() for match in WORLD_RE.finditer(links))

    world_ids = sorted(world_ids)
    checked_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    print(f"Checking live player counts for {len(world_ids)} unique VRChat worlds.")

    rows = []
    successful = 0
    for index, world_id in enumerate(world_ids):
        if index:
            time.sleep(REQUEST_GAP_SECONDS)

        result, name, status = fetch_world(world_id)
        if result:
            successful += 1
            row = result
        else:
            row = {
                "World ID": world_id,
                "World Name": name or world_id,
                "Total Players": "",
                "Public Players": "",
                "Private Players": "",
            }

        row["Checked At UTC"] = checked_at
        row["Status"] = status
        rows.append(row)
        print(f"{world_id}: {status}")

    write_tsv(rows)
    print(f"Wrote {successful}/{len(world_ids)} live population records to {OUTPUT}.")

    if not successful:
        raise SystemExit("No VRChat worlds returned usable live population data.")


if __name__ == "__main__":
    main()

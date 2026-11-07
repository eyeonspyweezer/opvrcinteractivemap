#!/usr/bin/env python3
"""Daily, unauthenticated VRChat world-visit snapshots for the OPVRC island map."""

import csv
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(".")
SOURCE = ROOT / "island-colors.tsv"
LATEST = ROOT / "island-world-visits.tsv"
HISTORY = ROOT / "island-world-visit-history.tsv"
ISLAND_TOTALS = ROOT / "island-visits.tsv"
WORLD_RE = re.compile(r"wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
API = "https://api.vrchat.cloud/api/1/worlds/{}"
USER_AGENT = "OPVRCIslandMap/1.0 (public world visit statistics; github.com/eyeonspyweezer/opvrcinteractivemap)"
REQUEST_GAP_SECONDS = 2.0
HISTORY_DAYS = 400
WINDOWS = (1, 7, 30)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(value):
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_tsv(path):
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def write_tsv(path, headers, rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def parse_time(value):
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def collect_islands():
    rows = read_tsv(SOURCE)
    islands = []
    world_ids = set()
    for row in rows:
        island_id = (row.get("ID") or "").strip()
        island_name = (row.get("Island Name") or "").strip()
        link_text = " ".join((row.get("Link") or "", row.get("WorldId") or ""))
        ids = sorted({m.group(0).lower() for m in WORLD_RE.finditer(link_text)})
        if not island_id or not island_name:
            continue
        islands.append({"id": island_id, "name": island_name, "world_ids": ids})
        world_ids.update(ids)
    return islands, sorted(world_ids)


def fetch_world(world_id):
    request = urllib.request.Request(
        API.format(world_id),
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                if response.status != 200:
                    return None, f"http_{response.status}"
                data = json.loads(response.read().decode("utf-8"))
            visits = data.get("visits")
            if isinstance(visits, bool) or not isinstance(visits, int) or visits < 0:
                return None, "visits_field_unavailable"
            return {
                "world_id": world_id,
                "world_name": str(data.get("name") or ""),
                "visits": visits,
            }, "ok"
        except urllib.error.HTTPError as exc:
            if exc.code == 429 or 500 <= exc.code < 600:
                retry_after = exc.headers.get("Retry-After")
                try:
                    wait = min(180, max(10, int(retry_after))) if retry_after else 30 * (attempt + 1)
                except ValueError:
                    wait = 30 * (attempt + 1)
                if attempt < 3:
                    print(f"{world_id}: HTTP {exc.code}; waiting {wait}s before retry")
                    time.sleep(wait)
                    continue
            return None, f"http_{exc.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            if attempt < 3:
                wait = 15 * (attempt + 1)
                print(f"{world_id}: {exc}; waiting {wait}s before retry")
                time.sleep(wait)
                continue
            return None, "request_failed"
    return None, "request_failed"


def main():
    if not SOURCE.exists():
        raise SystemExit("Missing island-colors.tsv")

    now = utc_now()
    now_text = iso(now)
    islands, world_ids = collect_islands()
    print(f"Found {len(islands)} islands and {len(world_ids)} unique VRChat worlds.")

    old_latest = {r.get("World ID", ""): r for r in read_tsv(LATEST)}
    history_rows = read_tsv(HISTORY)
    history_by_world = defaultdict(list)
    for row in history_rows:
        stamp = parse_time(row.get("Checked At UTC"))
        try:
            count = int(row.get("Lifetime Visits", ""))
        except (TypeError, ValueError):
            continue
        wid = (row.get("World ID") or "").strip()
        if stamp and wid:
            history_by_world[wid].append((stamp, count))

    latest_rows = []
    successful = 0
    for index, world_id in enumerate(world_ids):
        if index:
            time.sleep(REQUEST_GAP_SECONDS)
        result, status = fetch_world(world_id)
        if result:
            successful += 1
            latest_rows.append({
                "World ID": world_id,
                "World Name": result["world_name"],
                "Lifetime Visits": result["visits"],
                "Last Checked UTC": now_text,
                "Status": "ok",
            })
            history_by_world[world_id].append((now, result["visits"]))
        else:
            old = old_latest.get(world_id, {})
            latest_rows.append({
                "World ID": world_id,
                "World Name": old.get("World Name", ""),
                "Lifetime Visits": old.get("Lifetime Visits", ""),
                "Last Checked UTC": old.get("Last Checked UTC", ""),
                "Status": status,
            })
            print(f"{world_id}: {status}; preserving last known visit count")

    cutoff = now - dt.timedelta(days=HISTORY_DAYS)
    for wid in list(history_by_world):
        # Keep only the newest value for a duplicate timestamp/world pair.
        dedup = {}
        for stamp, count in history_by_world[wid]:
            if stamp >= cutoff:
                dedup[stamp] = count
        history_by_world[wid] = sorted(dedup.items())

    history_out = []
    for wid, samples in history_by_world.items():
        for stamp, count in samples:
            history_out.append({
                "Checked At UTC": iso(stamp),
                "World ID": wid,
                "Lifetime Visits": count,
            })
    history_out.sort(key=lambda r: (r["Checked At UTC"], r["World ID"]))

    latest_by_id = {r["World ID"]: r for r in latest_rows}

    def window_delta(world_id, days):
        samples = history_by_world.get(world_id, [])
        target = now - dt.timedelta(days=days)
        baseline = [(stamp, count) for stamp, count in samples if stamp <= target]
        if not baseline:
            return ""
        base_stamp, base_count = baseline[-1]
        # Do not label stale gaps as a precise 1/7/30-day period.
        if target - base_stamp > dt.timedelta(hours=36):
            return ""
        current = latest_by_id.get(world_id, {}).get("Lifetime Visits", "")
        try:
            current_count = int(current)
        except (TypeError, ValueError):
            return ""
        return max(0, current_count - base_count)

    island_totals = []
    for island in islands:
        ids = island["world_ids"]
        known = []
        for wid in ids:
            value = latest_by_id.get(wid, {}).get("Lifetime Visits", "")
            try:
                known.append((wid, int(value)))
            except (TypeError, ValueError):
                pass
        row = {
            "Island ID": island["id"],
            "Island Name": island["name"],
            "Lifetime Visits": sum(v for _, v in known) if known else "",
            "Visits 24h": "",
            "Visits 7d": "",
            "Visits 30d": "",
            "Worlds Total": len(ids),
            "Worlds Updated": len(known),
            "Last Checked UTC": now_text,
        }
        for days, field in ((1, "Visits 24h"), (7, "Visits 7d"), (30, "Visits 30d")):
            deltas = [window_delta(wid, days) for wid in ids]
            if ids and all(value != "" for value in deltas):
                row[field] = sum(deltas)
        island_totals.append(row)

    write_tsv(
        LATEST,
        ["World ID", "World Name", "Lifetime Visits", "Last Checked UTC", "Status"],
        latest_rows,
    )
    write_tsv(
        HISTORY,
        ["Checked At UTC", "World ID", "Lifetime Visits"],
        history_out,
    )
    write_tsv(
        ISLAND_TOTALS,
        ["Island ID", "Island Name", "Lifetime Visits", "Visits 24h", "Visits 7d",
         "Visits 30d", "Worlds Total", "Worlds Updated", "Last Checked UTC"],
        island_totals,
    )
    print(f"Updated {successful}/{len(world_ids)} worlds. Wrote {len(history_out)} historical snapshots.")
    if successful == 0:
        print("WARNING: No worlds returned a usable visits field. Check API response before relying on totals.")


if __name__ == "__main__":
    main()

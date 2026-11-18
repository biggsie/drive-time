#!/usr/bin/env python3
"""Hourly drive-time collector.

For each direction in config.json, asks Google's Routes API (computeRoutes) for the
traffic-aware drive time departing now, +1h, +2h and +3h, then writes:

  data/latest.json               current reading + forecast, both directions
  data/history/YYYY-MM.json      observed records (departing "now"), appended
  data/forecasts/YYYY-MM.json    every forecast made (optional, for accuracy checks)
  data/history/index.json        list of available months, for the front end

Standard library only. Needs GOOGLE_MAPS_API_KEY in the environment.

Nothing is ever invented: a failed API call is logged in latest.json's "errors"
list and produces no record. If every call fails, no files are touched and the
script exits non-zero so the GitHub Actions run shows as failed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELD_MASK = "routes.duration,routes.staticDuration,routes.distanceMeters"
SCHEMA_VERSION = 1


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_seconds(value: str | None) -> int | None:
    # The Routes API returns durations as strings like "10815s".
    if not value:
        return None
    return int(round(float(value.rstrip("s"))))


def compute_route(api_key: str, origin: str, destination: str, departure: datetime | None,
                  routing_preference: str, traffic_model: str | None) -> dict:
    body: dict = {
        "origin": {"address": origin},
        "destination": {"address": destination},
        "travelMode": "DRIVE",
        "routingPreference": routing_preference,
    }
    # departureTime omitted = "now" (the API uses the time the request is received).
    # Sending an explicit "now" risks it arriving in the past, which DRIVE rejects.
    if departure is not None:
        body["departureTime"] = iso_utc(departure)
    if routing_preference == "TRAFFIC_AWARE_OPTIMAL" and traffic_model:
        body["trafficModel"] = traffic_model

    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": FIELD_MASK,
        },
    )
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.load(resp)
            routes = payload.get("routes") or []
            if not routes:
                raise RuntimeError(f"no route returned: {json.dumps(payload)[:300]}")
            r = routes[0]
            duration = parse_seconds(r.get("duration"))
            if duration is None:
                raise RuntimeError(f"route has no duration: {json.dumps(r)[:300]}")
            return {
                "duration_seconds": duration,
                "static_duration_seconds": parse_seconds(r.get("staticDuration")),
                "distance_meters": r.get("distanceMeters"),
            }
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            last_error = RuntimeError(f"HTTP {e.code}: {detail}")
            if e.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = e
        time.sleep(2 ** attempt * 2)
    raise RuntimeError(str(last_error))


def read_records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text())


def write_records(path: Path, records: list[dict]) -> None:
    # One record per line keeps git diffs small and readable.
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ",\n".join(json.dumps(r, separators=(",", ":")) for r in records)
    path.write_text("[\n" + lines + "\n]\n" if records else "[]\n")


def append_records(path: Path, new: list[dict], key: tuple[str, ...]) -> None:
    records = read_records(path)
    seen = {tuple(r.get(k) for k in key) for r in records}
    for r in new:
        if tuple(r.get(k) for k in key) not in seen:
            records.append(r)
    records.sort(key=lambda r: tuple(str(r.get(k)) for k in key))
    write_records(path, records)


def write_month_index(history_dir: Path) -> None:
    months = sorted(p.stem for p in history_dir.glob("????-??.json"))
    (history_dir / "index.json").write_text(json.dumps({"months": months}, indent=2) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.json"))
    ap.add_argument("--data-dir", default=str(ROOT / "data"))
    args = ap.parse_args()

    api_key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if not api_key:
        print("GOOGLE_MAPS_API_KEY is not set.", file=sys.stderr)
        return 2

    config = json.loads(Path(args.config).read_text())
    coll = config["collection"]
    tz = ZoneInfo(config["display"]["timezone"])
    data_dir = Path(args.data_dir)

    run_started = datetime.now(timezone.utc)
    latest: dict = {
        "schema": SCHEMA_VERSION,
        "generated_at_utc": None,
        "routing_preference": coll["routing_preference"],
        "traffic_model": coll.get("traffic_model"),
        "routes": {},
        "errors": [],
    }
    observed: list[dict] = []
    forecasts: list[dict] = []

    for direction, route in config["routes"].items():
        entry = {
            "label": route["label"],
            "origin": route["origin"],
            "destination": route["destination"],
            "forecast": [],
        }
        for offset in coll["forecast_offsets_hours"]:
            requested_at = datetime.now(timezone.utc)
            departure = None if offset == 0 else requested_at + timedelta(hours=offset)
            try:
                result = compute_route(api_key, route["origin"], route["destination"], departure,
                                       coll["routing_preference"], coll.get("traffic_model"))
            except Exception as e:  # noqa: BLE001 - every failure is recorded, never papered over
                latest["errors"].append({
                    "direction": direction, "offset_hours": offset,
                    "requested_at_utc": iso_utc(requested_at), "error": str(e)[:500],
                })
                print(f"[{direction} +{offset}h] ERROR {e}", file=sys.stderr)
                continue

            depart_at = departure or requested_at
            point = {
                "offset_hours": offset,
                "requested_at_utc": iso_utc(requested_at),
                "departure_time_utc": iso_utc(depart_at),
                **result,
            }
            entry["forecast"].append(point)
            print(f"[{direction} +{offset}h] {result['duration_seconds'] / 60:.1f} min "
                  f"(no-traffic {(result['static_duration_seconds'] or 0) / 60:.1f} min)")

            if offset == 0:
                local = requested_at.astimezone(tz)
                obs = {
                    "timestamp_utc": iso_utc(requested_at),
                    "local_date": local.strftime("%Y-%m-%d"),
                    "local_hour": local.hour,
                    "weekday": local.strftime("%a"),
                    "direction": direction,
                    "duration_seconds": result["duration_seconds"],
                    "static_duration_seconds": result["static_duration_seconds"],
                    "distance_meters": result["distance_meters"],
                }
                observed.append(obs)
                entry["now"] = obs
            forecasts.append({
                "requested_at_utc": iso_utc(requested_at),
                "direction": direction,
                "offset_hours": offset,
                "departure_time_utc": iso_utc(depart_at),
                **result,
            })
        latest["routes"][direction] = entry

    if not forecasts:
        print("Every API call failed; leaving data files untouched.", file=sys.stderr)
        return 1

    latest["generated_at_utc"] = iso_utc(run_started)
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "latest.json").write_text(json.dumps(latest, indent=2, ensure_ascii=False) + "\n")

    # Monthly files are keyed by Pacific calendar month, matching local_date bucketing.
    by_month: dict[str, list[dict]] = {}
    for r in observed:
        by_month.setdefault(r["local_date"][:7], []).append(r)
    for month, recs in by_month.items():
        append_records(data_dir / "history" / f"{month}.json", recs, ("timestamp_utc", "direction"))
    write_month_index(data_dir / "history")

    if coll.get("log_forecasts"):
        f_by_month: dict[str, list[dict]] = {}
        for r in forecasts:
            month = datetime.fromisoformat(r["requested_at_utc"].replace("Z", "+00:00")).astimezone(tz).strftime("%Y-%m")
            f_by_month.setdefault(month, []).append(r)
        for month, recs in f_by_month.items():
            append_records(data_dir / "forecasts" / f"{month}.json", recs,
                           ("requested_at_utc", "direction", "offset_hours"))

    # Partial failures still exit 0 so the successful readings get committed; the
    # failures are listed in latest.json["errors"] and surfaced on the display.
    return 0


if __name__ == "__main__":
    sys.exit(main())

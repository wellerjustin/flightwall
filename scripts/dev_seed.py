"""One-shot adsb.lol pull to a local JSON file.

Useful for offline development (no network) or for unit-testing the
enricher / projector against a real-world payload. Run from anywhere:

    python scripts/dev_seed.py --lat 34.4612 --lon -109.6052 --dist 250 --out sample.json
"""
from __future__ import annotations
import argparse
import json
import sys
import urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=34.4612)
    ap.add_argument("--lon", type=float, default=-109.6052)
    ap.add_argument("--dist", type=int, default=250)
    ap.add_argument("--out", default="sample.json")
    args = ap.parse_args()

    url = f"https://api.adsb.lol/v2/lat/{args.lat}/lon/{args.lon}/dist/{args.dist}"
    req = urllib.request.Request(url, headers={"User-Agent": "FlightWall-dev/1.0"})
    print(f"GET {url}")
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode("utf-8"))

    n = len(data.get("ac", []))
    with open(args.out, "w") as f:
        json.dump(data, f, indent=2)
    print(f"saved {n} aircraft to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

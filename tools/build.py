#!/usr/bin/env python3
"""Turn the raw photo folder into web images + photos.json.

Usage (from the repo root):
    python tools/build.py [--src originals] [--force]

Reads   originals/*            (never committed)
Writes  img/*.webp, img/thumbs/*.webp, photos.json
Uses    tools/geocache.json    (Nominatim cache, committed)
        tools/overrides.json   (manual fixes, committed, always win)
        tools/buildstate.json  (source hash -> outputs, so reruns are cheap)
Reports tools/review.csv       (conflicts, missing dates, duplicates; gitignored)
"""

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # HEIC files will be reported as unreadable
    pass

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
IMG = ROOT / "img"
THUMBS = IMG / "thumbs"

GEOCACHE = TOOLS / "geocache.json"
OVERRIDES = TOOLS / "overrides.json"
BUILDSTATE = TOOLS / "buildstate.json"
REVIEW = TOOLS / "review.csv"
PHOTOS = ROOT / "photos.json"

EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}
DISPLAY_PX, THUMB_PX = 1600, 400
DISPLAY_Q, THUMB_Q = 80, 75
CONFLICT_KM = 50

NOMINATIM = "https://nominatim.openstreetmap.org"
USER_AGENT = "rafapages-hms/1.0 (+https://rafapages.com/hms/)"
LANG = "es"
CITY_TYPES = {"city", "town", "village", "municipality", "hamlet", "suburb", "borough", "city_district"}


# ---------- small helpers ----------

def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def slugify(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "foto"


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def map_link(lat, lon):
    return f"https://www.openstreetmap.org/?mlat={lat:.5f}&mlon={lon:.5f}#map=12/{lat:.5f}/{lon:.5f}"


# ---------- filename parsing ----------

def parse_filename(name):
    """'Copenhague (2).JPG' -> ('Copenhague', None); 'Sofia 2024.JPG' -> ('Sofia', '2024').

    Strips bracketed notes, copy counters (' 2', '-1', '(1)') and a trailing year,
    which is returned as a hint for the review file (never used as a date).
    """
    stem = unicodedata.normalize("NFC", Path(name).stem)
    stem = re.sub(r"\(.*?\)", " ", stem)
    year = None
    m = re.search(r"[\s_-]+((?:19|20)\d{2})\s*$", stem)
    if m:
        year, stem = m.group(1), stem[: m.start()]
    stem = re.sub(r"[\s_-]+\d{1,2}\s*$", "", stem)
    stem = re.sub(r"(?<=[a-záéíóúüñ])(?=[A-ZÁÉÍÓÚÜÑ])", " ", stem)  # SantaMonica -> Santa Monica
    stem = re.sub(r"[\s_]+", " ", stem).strip(" -_")
    return stem, year


# ---------- EXIF ----------

def _ratio(v):
    try:
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _gps_deg(dms, ref):
    if not dms or len(dms) != 3:
        return None
    d, m, s = (_ratio(x) for x in dms)
    if None in (d, m, s):
        return None
    deg = d + m / 60 + s / 3600
    return -deg if ref in ("S", "W") else deg


def read_exif(im):
    ex = im.getexif()
    sub = ex.get_ifd(0x8769)
    gps = ex.get_ifd(0x8825)
    raw = sub.get(36867) or sub.get(36868) or ex.get(306)
    taken = None
    if raw:
        m = re.match(r"(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})", str(raw).strip())
        if m and m.group(1) != "0000":
            y, mo, d, h, mi, s = m.groups()
            taken = f"{y}-{mo}-{d}T{h}:{mi}:{s}"
    lat = _gps_deg(gps.get(2), gps.get(1))
    lon = _gps_deg(gps.get(4), gps.get(3))
    if lat is not None and lon is not None and (abs(lat) < 1e-6 and abs(lon) < 1e-6):
        lat = lon = None  # 0,0 means "no fix" on some phones
    model = (ex.get(272) or "").strip().strip("\x00") or None
    make = (ex.get(271) or "").strip().strip("\x00")
    if model and make and not model.lower().startswith(make.split()[0].lower()) and make.lower() not in ("apple",):
        model = f"{make} {model}"
    return taken, lat, lon, model


# ---------- geocoding ----------

class Geocoder:
    def __init__(self, cache):
        self.cache = cache
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.last = 0.0
        self.lookups = 0

    def _get(self, path, params):
        wait = 1.1 - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        params = {**params, "format": "jsonv2", "addressdetails": 1, "accept-language": LANG}
        r = self.session.get(f"{NOMINATIM}/{path}", params=params, timeout=30)
        self.last = time.time()
        self.lookups += 1
        r.raise_for_status()
        return r.json()

    @staticmethod
    def _place(res):
        a = res.get("address", {})
        city = res.get("name") if res.get("addresstype") in CITY_TYPES else None
        city = city or a.get("city") or a.get("town") or a.get("village") or a.get("municipality") or res.get("name")
        return {
            "lat": round(float(res["lat"]), 5),
            "lon": round(float(res["lon"]), 5),
            "city": city,
            "country": a.get("country"),
            "countryCode": (a.get("country_code") or "").upper() or None,
            "type": res.get("addresstype"),
            "display": res.get("display_name"),
        }

    def search(self, query):
        key = f"search:{query.lower()}"
        if key not in self.cache:
            results = self._get("search", {"q": query, "limit": 5})
            best = next((r for r in results if r.get("addresstype") in CITY_TYPES), results[0] if results else None)
            self.cache[key] = self._place(best) if best else None
        return self.cache[key]

    def reverse(self, lat, lon):
        key = f"reverse:{lat:.3f},{lon:.3f}"
        if key not in self.cache:
            res = self._get("reverse", {"lat": f"{lat:.6f}", "lon": f"{lon:.6f}", "zoom": 10})
            self.cache[key] = self._place(res) if res and "lat" in res else None
        return self.cache[key]


# ---------- images ----------

def write_images(im, image_path, thumb_path):
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    disp = im.copy()
    disp.thumbnail((DISPLAY_PX, DISPLAY_PX), Image.LANCZOS)
    disp.save(image_path, "WEBP", quality=DISPLAY_Q, method=6)  # no exif= -> metadata stripped
    thumb = im.copy()
    thumb.thumbnail((THUMB_PX, THUMB_PX), Image.LANCZOS)
    thumb.save(thumb_path, "WEBP", quality=THUMB_Q, method=6)
    return disp.size


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=str(ROOT / "originals"), help="folder with the original photos")
    ap.add_argument("--force", action="store_true", help="re-encode every image")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        sys.exit(f"Source folder not found: {src}")

    IMG.mkdir(exist_ok=True)
    THUMBS.mkdir(exist_ok=True)
    cache = load_json(GEOCACHE, {})
    overrides = load_json(OVERRIDES, {})
    place_aliases = {k.lower(): v for k, v in overrides.get("places", {}).items() if not k.startswith("_")}
    photo_over = {unicodedata.normalize("NFC", k): v for k, v in overrides.get("photos", {}).items() if not k.startswith("_")}
    country_names = {k: v for k, v in overrides.get("countries", {}).items() if not k.startswith("_")}
    state = load_json(BUILDSTATE, {})
    geo = Geocoder(cache)

    files = sorted(
        (p for p in src.iterdir() if p.is_file() and p.suffix.lower() in EXTS and not p.name.startswith(".")),
        key=lambda p: unicodedata.normalize("NFC", p.name).lower(),
    )

    photos, review, seen_hashes, used_ids = [], [], {}, set()
    new_state, encoded = {}, 0

    def flag(fname, issue, **kw):
        review.append({"file": fname, "issue": issue, **kw})

    for path in files:
        fname = unicodedata.normalize("NFC", path.name)
        ov = photo_over.get(fname, {})
        if ov.get("skip"):
            continue

        digest = sha1(path)
        if digest in seen_hashes:
            flag(fname, "duplicate", detail=f"identical to {seen_hashes[digest]}; skipped")
            continue
        seen_hashes[digest] = fname

        try:
            im = Image.open(path)
            taken, glat, glon, camera = read_exif(im)
        except Exception as e:  # noqa: BLE001
            flag(fname, "unreadable", detail=str(e))
            continue

        place, year_hint = parse_filename(fname)
        alias = place_aliases.get(place.lower(), place)
        if isinstance(alias, dict):  # {"query": ..., "city": ...}
            ov = {"city": alias.get("city"), **ov} if alias.get("city") else ov
            alias = alias.get("query", place)
        query = ov.get("place") or alias
        named = geo.search(query) if query else None
        has_gps = glat is not None and not ov.get("ignoreGps")
        gps_place = geo.reverse(glat, glon) if has_gps else None

        # Decide where the pin goes and what it is called.
        use = ov.get("use")  # "gps" | "filename" | None
        if has_gps and named:
            dist = haversine_km((glat, glon), (named["lat"], named["lon"]))
            if dist > CONFLICT_KM and not use:
                flag(
                    fname, "gps_vs_filename",
                    detail=f"{dist:.0f} km apart; using GPS until overrides.json says otherwise",
                    filename_place=f"{named['city']}, {named['country']}",
                    filename_map=map_link(named["lat"], named["lon"]),
                    gps_place=f"{(gps_place or {}).get('city')}, {(gps_place or {}).get('country')}",
                    gps_map=map_link(glat, glon),
                )
                use = "gps_named_by_gps"
            elif dist > CONFLICT_KM and use == "gps":
                use = "gps_named_by_gps"
            elif dist <= CONFLICT_KM:
                use = use or "gps"
        if has_gps and not named:
            use = use or "gps_named_by_gps"
        if not has_gps:
            use = "filename"

        if use == "filename" or (use == "gps" and not has_gps):
            if not named:
                flag(fname, "no_location", detail=f"could not geocode '{query}' and no GPS")
                continue
            lat, lon, precision, label = named["lat"], named["lon"], "city", named
        elif use == "gps_named_by_gps":
            lat, lon, precision, label = glat, glon, "gps", gps_place or named or {}
        else:  # gps position, filename name (the normal case)
            lat, lon, precision, label = glat, glon, "gps", named

        if ov.get("lat") is not None and ov.get("lon") is not None:
            lat, lon = ov["lat"], ov["lon"]
            precision = ov.get("precision", "gps")

        if "takenAt" in ov:
            taken = ov["takenAt"]
            if taken and not re.fullmatch(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?", taken):
                sys.exit(f"overrides.json: bad takenAt for {fname}: {taken!r} (use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)")
        date_approx = ov.get("dateApprox") if taken else None
        if not taken:
            flag(fname, "missing_date", detail=f"filename year hint: {year_hint}" if year_hint else "")

        city = ov.get("city") or label.get("city") or place
        cc = ov.get("countryCode") or label.get("countryCode")
        country = ov.get("country") or country_names.get(cc) or label.get("country")
        if named and named.get("type") not in CITY_TYPES and not ov.get("city"):
            flag(fname, "not_a_city", detail=f"'{query}' geocoded as {named.get('type')}: {named.get('display')}")

        base = slugify(city) + "-" + (taken[:10] if taken else "sin-fecha-" + digest[:6])
        pid, n = base, 2
        while pid in used_ids:
            pid, n = f"{base}-{n}", n + 1
        used_ids.add(pid)

        image_rel, thumb_rel = f"img/{pid}.webp", f"img/thumbs/{pid}.webp"
        prev = state.get(digest)
        if (
            args.force
            or not prev
            or prev.get("id") != pid
            or not (ROOT / image_rel).exists()
            or not (ROOT / thumb_rel).exists()
        ):
            w, h = write_images(im, ROOT / image_rel, ROOT / thumb_rel)
            encoded += 1
        else:
            w, h = prev["w"], prev["h"]
        new_state[digest] = {"id": pid, "w": w, "h": h, "file": fname}

        photos.append({
            "id": pid,
            "image": image_rel,
            "thumb": thumb_rel,
            "w": w,
            "h": h,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "precision": precision,
            "city": city,
            "country": country,
            "countryCode": cc,
            "takenAt": taken,
            "dateApprox": date_approx,
            "camera": ov.get("camera", camera),
            "caption": ov.get("caption"),
            "people": ov.get("people", []),
        })

    # Remove published images whose source is gone.
    keep = {p["image"] for p in photos} | {p["thumb"] for p in photos}
    removed = 0
    for f in list(IMG.glob("*.webp")) + list(THUMBS.glob("*.webp")):
        if f.relative_to(ROOT).as_posix() not in keep:
            f.unlink()
            removed += 1

    photos.sort(key=lambda p: (p["takenAt"] is None, p["takenAt"] or "", p["id"]))
    PHOTOS.write_text(json.dumps(photos, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    save_json(GEOCACHE, cache)
    save_json(BUILDSTATE, new_state)

    cols = ["file", "issue", "detail", "filename_place", "filename_map", "gps_place", "gps_map"]
    with open(REVIEW, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for row in review:
            w.writerow({c: row.get(c, "") for c in cols})

    count = lambda issue: sum(r["issue"] == issue for r in review)  # noqa: E731
    print(f"{len(photos)} photos  ({sum(p['precision'] == 'gps' for p in photos)} with GPS)")
    print(f"{count('gps_vs_filename')} GPS/filename conflicts, {count('missing_date')} missing dates, "
          f"{count('duplicate')} duplicates, {count('not_a_city')} not-a-city, "
          f"{count('no_location') + count('unreadable')} skipped")
    print(f"{encoded} images encoded, {removed} stale images removed, {geo.lookups} Nominatim lookups")
    if review:
        print(f"Review: {REVIEW.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

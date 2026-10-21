# H&M Photo Map: Spec

Oct 21, 2026 · @Rafael Pagés

## Overview

A minimal, slightly playful world map on rafapages.com that pins all 69 family photos taken at H&M stores. Tapping or hovering a pin shows the photo with date, time, city and country. It is public but unlinked, built in plain HTML/CSS/JS, and costs nothing to run.

Goals:

- Get the existing 69 photos on a live map with one manual review pass.
- Make adding new photos easy enough that family members actually do it.
- Add a few fun extras (stats, timeline, route) once the basics work.

Non-goals for now: user accounts, face detection, comments, an admin UI.

## Decisions so far

| Topic | Decision |
| --- | --- |
| Source of photos | Dropbox folder, 69 JPGs, \~160 MB, location in filename (e.g. `roma.jpg`) |
| Pin placement | EXIF GPS if present (exact spot); otherwise city centre from the filename |
| GPS vs filename conflict | Flag it in a report for Rafa to decide; never resolve silently |
| Manual review | One-time pass over the current photos is fine |
| Popup content | Photo, date, time, city, country |
| Interaction | Hover on desktop, tap to open a card on mobile |
| Extras | Wanted: stats, timeline, route, gallery |
| Map style | Minimal, with a playful touch |
| Visibility | Public, on rafapages.com, not linked from the main site |
| Branding | Open; keep the H&M nod to name and red accent, no official logo file |
| Stack | Plain HTML/CSS/JS in a new public repo, rafapages/hms, served at rafapages.com/hms/ |
| Budget | Free; compress images |
| People tagging | Deferred; optional manual names field reserved in the data model |

## Data pipeline

A Python script (`build.py`) turns the raw Dropbox folder into web-ready images plus one `photos.json`. The site never touches the originals.

1. **Ingest.** Read every image from a local copy of the Dropbox folder (Phase 1: just sync or download it; Phase 3 pulls it automatically).
2. **Parse filename.** `roma.jpg` gives the place `roma`. Strip trailing numbers or suffixes so `roma2.jpg` and `roma (1).jpg` map to the same place.
3. **Read EXIF.** With Pillow: `DateTimeOriginal` (date and time), GPS lat/lon, camera model. Old cameras may have neither; that is fine.
4. **Geocode the filename** with OpenStreetMap Nominatim (free, 1 request per second, needs a user agent). Results are cached in `geocache.json` so each place is looked up once.
5. **Reverse geocode GPS** (when present) to get city and country, using the same cache.
6. **Check for conflicts.** If GPS and the filename city are more than \~50 km apart, write the photo to `review.csv` with both positions and a map link.
7. **Apply overrides.** `overrides.json` holds your manual fixes: a corrected place, date, or a choice of "use GPS" or "use filename". Overrides always win.
8. **Process images.** Auto-rotate from EXIF, then write a \~1600 px display image (JPEG/WebP, quality \~80) and a \~400 px thumbnail. Strip all EXIF from published files; only the fields we chose go into the JSON.
9. **Write `photos.json`** and a short summary: N photos, N with GPS, N conflicts, N missing dates.

The script is idempotent: rerun it any time and it only reprocesses new or changed photos.

**Size estimate:** 69 photos at \~350 KB display + \~30 KB thumbnail is roughly 26 MB, well within GitHub Pages limits (1 GB repo, 100 MB per file).

**Missing dates:** if a photo has no EXIF date, leave it empty and list it in the review file. Dropbox file dates are unreliable, so don't guess from them.

## Data model

One entry per photo in `photos.json`:

```json
{
  "id": "roma-2019-06-14",
  "image": "img/roma-2019-06-14.webp",
  "thumb": "img/thumbs/roma-2019-06-14.webp",
  "lat": 41.9009,
  "lon": 12.4833,
  "precision": "gps",
  "city": "Rome",
  "country": "Italy",
  "countryCode": "IT",
  "takenAt": "2019-06-14T17:42:00",
  "camera": "iPhone XS",
  "caption": null,
  "people": []
}
```

- `precision` is `gps` or `city`, so the map can show city-level pins slightly differently (e.g. hollow vs filled).
- `takenAt` is local time as the camera recorded it, with no timezone conversion.
- `caption` and `people` are reserved for later and can stay empty.
- Photos taken at the same store or city stack into one pin with a small carousel.

## Website

One static page that loads `photos.json` and renders everything client-side.

**Map**

- MapLibre GL JS with the free OpenFreeMap "positron" style: light, minimal, no API key, no usage fees. Fallback: Leaflet with CARTO light tiles.
- Pins in H&M-ish red. Built-in clustering so Europe doesn't become a red blob; clusters show a count and zoom in on click.
- GPS pins filled, city-level pins hollow, so it's honest about precision.

**Photo card**

- Desktop: hover shows a small card with the thumbnail; click opens the full photo.
- Mobile: tap opens the card; tap the image for full screen.
- Shows city, country (with flag emoji), date and time. Stacked photos get prev/next arrows.

**Extras**

- **Stats bar:** photos, countries, cities, years spanned, first and latest photo, farthest from Madrid.
- **Timeline:** a year slider that filters pins, plus a play button that animates the years.
- **Route:** a toggle that draws a dashed line connecting photos in chronological order.
- **Gallery:** a grid view sorted by date, grouped by year or country.

**Playful touches (pick some)**

- Title along the lines of "The Family H&M World Tour", red accent, a hand-drawn style font for headings.
- A small "next destination?" easter egg: the nearest H&M country not yet visited.

**Housekeeping**

- `<meta name="robots" content="noindex">` and a `robots.txt` disallow, since it's meant to be unlinked.
- Thumbnails lazy-load; full images load only when opened, so first paint stays light.
- No build tooling: one `index.html`, one `style.css`, one `app.js`.

## Hosting and repo layout

The site gets its own public repo, `rafapages/hms`, with GitHub Pages enabled (deploy from `main`, root folder). Because `rafapages.github.io` already uses the custom domain rafapages.com, GitHub serves it automatically at `rafapages.com/hms/`. No DNS changes needed.

```
hms/                 public repo, GitHub Pages on
  index.html
  style.css
  app.js
  photos.json
  img/               display images (~1600 px)
  img/thumbs/        thumbnails (~400 px)
  tools/
    build.py
    requirements.txt pillow, requests
    geocache.json
    overrides.json
  .gitignore         originals/, review.csv
```

- Free Pages needs a public repo, so originals are never committed. They stay in Dropbox (and in a gitignored `originals/` folder locally), and published images have EXIF stripped.
- Keeping the build script in the same repo simplifies Phase 3: the GitHub Action runs right there.
- `robots.txt` only works at the domain root, so the `Disallow: /hms/` line goes in `rafapages.github.io`. The `noindex` meta tag in `hms/index.html` covers it either way.
- Use relative paths in the HTML (`img/...`, not `/img/...`), since the site lives under `/hms/`.

## Phases

&#91;embedded content: roadmap · 4 phases, 3 gates\]

Each phase is usable on its own; later phases only start if the earlier one earned it.

**Why Dropbox for uploads instead of a shared password.** GitHub Pages is static, so an upload form needs a backend: a serverless function (e.g. a Cloudflare Worker) holding a GitHub token, plus rate limiting and file validation. A shared Dropbox folder reuses what the family already has, keeps the same naming rule (city name as filename), and deleting a photo is just deleting the file. The Action uses a Dropbox app scoped to that one folder, with its token stored as a GitHub secret. If the family later wants a proper web form, it can be added on top without changing anything else.

## Open questions

- [ ] Are filenames always a single city (`roma.jpg`), or sometimes city plus store or country (`london-oxford-st.jpg`, `paris2.jpg`)? A few real examples will shape the parser.
- [ ] Are filenames in Spanish, English or mixed (`roma` vs `rome`, `londres`)? Nominatim handles most, but the review file will catch misses.
- [ ] Do you want a caption field from day one ("the one where it rained"), or later?
- [ ] Should photos from the same city but different stores be separate pins?
- [ ] Title and tone: in English, Spanish, or both?

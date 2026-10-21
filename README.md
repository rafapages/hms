# hms

Fun family project: **La Vuelta al Mundo en H&M**, a map of every family photo taken at an H&M store. Served at rafapages.com/hms/ via GitHub Pages (no build step for the site).

- Spec: [docs/H&M Photo Map Spec.md](docs/H&M%20Photo%20Map%20Spec.md)

## Site

`index.html`, `style.css`, `app.js` and `photos.json`. MapLibre GL + OpenFreeMap positron (tinted), no API keys. To preview locally:

```sh
python3 -m http.server 8000   # then open http://localhost:8000/
```

## Adding or fixing photos

Originals live in Dropbox and in a local, gitignored `originals/` folder. Name each file after the city (`Roma.jpg`, `Lisboa (2).JPG`, `Sofia 2024.JPG` all work).

```sh
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt   # once
.venv/bin/python tools/build.py
```

The build writes `img/`, `img/thumbs/` and `photos.json`, and lists anything that needs a human in `tools/review.csv` (GPS vs filename conflicts, missing dates, duplicates, places that aren't cities). It only re-encodes new or changed photos.

Fix things in `tools/overrides.json` and rerun the build:

```json
{
  "places":    { "colonia": "Köln, Germany" },
  "countries": { "US": "Estados Unidos" },
  "photos": {
    "Roma.jpg":     { "use": "filename" },
    "Alemania.JPG": { "place": "Frankfurt" },
    "Sofia 2024.JPG": { "takenAt": "2024-05-01T12:00:00" },
    "Guille N.Y.JPG": { "people": ["Guille"], "caption": "…" }
  }
}
```

Photo keys: `place`, `use` (`gps` | `filename`), `takenAt`, `city`, `country`, `countryCode`, `lat`, `lon`, `caption`, `people`, `skip`, `ignoreGps`.

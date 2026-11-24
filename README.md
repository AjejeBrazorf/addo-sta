# Addo' sta? · Napoli

A small, phone-first web app for getting around Naples. It puts EAV rail and bus, ANM and FS Linea 2 in one place: search a stop, a station or a line, see the next departures, follow a line on the map, find the stops near you.

The interface is in Italian.

## What it does

- **Search** stops, stations and lines across all four networks, grouped by operator.
- **Departure boards**: live boards for EAV rail stations and FS Linea 2 stations; ANM stops show GTFS timetables with real-time predictions where available.
- **Lines**: the ordered list of stops and the path drawn on the map.
- **Near me**: the GPS button centres the map on you and lists the closest stops.
- **Live vehicles**: ANM vehicle positions on the map, labelled as measured GPS positions.

Data freshness is always shown, and predictions are always labelled as predictions.

## Run it locally

Requires Node.js 22 or newer (it uses the built-in `node:sqlite`). There are no npm dependencies.

```sh
npm start          # http://localhost:8787
npm test
```

On first start the server downloads the EAV and ANM GTFS feeds and builds a SQLite database in `data/` (ignored by git). This takes a minute; the live boards work in the meantime.

Locally, no password is required unless you set `ACCESS_PASSWORD`.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` / `HOST` | Listen address. Default `8787` / `0.0.0.0`. |
| `ACCESS_PASSWORD` | Shared password for the whole app. Required on Fly or with `NODE_ENV=production`. |
| `SESSION_SECRET` | Key for the login cookie. Required on Fly or with `NODE_ENV=production`. Changing it, or the password, logs everyone out. |
| `BUSONE_CLIENT` | Sent as `X-BusOne-Client` to the BusOne proxy. BusOne asks for the app name **and a contact**: set it to something like `Addo' sta (you@example.com)`. |
| `BUSONE_USE` | Sent as `X-BusOne-Use`. Default `personal`. |

## Deploy (Fly.io)

```sh
fly launch --no-deploy
fly volumes create banchina_data --size 1
fly secrets set ACCESS_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32) BUSONE_CLIENT="..."
fly deploy
```

The app refuses to start on Fly without `ACCESS_PASSWORD` and `SESSION_SECRET`. Every page and API route sits behind the password, except `/healthz` and the icons and manifest needed by the login page. Failed logins are rate-limited per IP.

## Project layout

```
server.js         HTTP server, auth, API routes
src/ingest.js     GTFS download and SQLite build (runs in a worker)
src/schedule.js   timetable and search queries
src/live.js       EAV station boards and ViaggiaTreno (FS Linea 2)
src/realtime.js   ANM GTFS-Realtime via BusOne
src/protobuf.js   minimal GTFS-RT decoder
public/           the front end: plain ES modules, Leaflet, MapLibre
test/             node:test suites
```

## Data sources and credits

This repository contains **code only**. No timetable or real-time data is committed; the server fetches it at runtime. The two GTFS-Realtime snapshots in `test/fixtures/` are small samples of ANM data via BusOne, used only by the tests.

| Data | Source | Terms |
|---|---|---|
| EAV timetables (rail and bus) | [EAV open data](https://www.eavsrl.it/open-data/) | [Italian Open Data License 2.0](https://www.dati.gov.it/iodl/2.0/) |
| EAV live station boards | [EAV teleindicatori](https://orariotreni.eavsrl.it/teleindicatori/), linked from EAV's open data page | No published terms |
| ANM and FS Linea 2 timetables | ANM GTFS, also listed on [Transitland](https://www.transit.land/feeds/f-s-anm~it) | See the feed's licence on Transitland |
| ANM real-time positions and predictions | [BusOne](https://busone.app) proxy of ANM data | Free, non-commercial use, attribution "BusOne (https://busone.app) e fonte originale" |
| FS Linea 2 delays | [ViaggiaTreno](http://www.viaggiatreno.it) (Trenitalia / RFI) | No published API terms |
| Base map | [OpenFreeMap](https://openfreemap.org), © [OpenMapTiles](https://openmaptiles.org), data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) | Attribution required. The raster fallback follows the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) |
| Libraries | [Leaflet](https://leafletjs.com) (BSD-2), [MapLibre GL JS](https://maplibre.org) (BSD-3), [Schibsted Grotesk](https://fonts.google.com/specimen/Schibsted+Grotesk) (OFL) | Loaded from CDNs, not vendored |

Map credits are shown on the map, bottom left. All credits are in the app under ⓘ *Fonti e crediti*.

## Disclaimer

Addo' sta is an independent, non-commercial personal project. It is not affiliated with or endorsed by EAV, ANM, Trenitalia, RFI or BusOne. Times and positions come from third-party sources and can be wrong or missing; check official channels before relying on them.

Some live sources (the EAV station boards and ViaggiaTreno) are public web endpoints without a documented API. If you run your own instance, keep the request rate low, keep it personal and non-commercial, and respect each source's terms.

## License

The code is released under the [MIT License](LICENSE). The licence covers this code only: the data the app fetches stays under its sources' own terms, listed above.

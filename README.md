# Tahoe drive-time wall display

A wall-mounted iPad page that answers one question: **when should we leave?**
It covers Mill Valley ↔ Truckee in both directions.

- **Front end:** static HTML/CSS/JS (no framework, no build step) on GitHub Pages.
- **Collector:** `scripts/collect.py` (Python standard library only), run hourly by
  `.github/workflows/collect.yml` via `scripts/collect-loop.sh`. It calls Google's Routes API and commits JSON to `data/`.
- **No server, no database, no sample data.** Every value comes from a real API call.
  Until readings exist, the display shows a "Collecting data" state.

## Files

| Path | What |
|---|---|
| `config.json` | Addresses, collection settings, display defaults, refresh intervals |
| `data/latest.json` | Latest run: "now" reading + forecasts for +0/+1/+2h, both directions, plus any request errors |
| `data/history/YYYY-MM.json` | **Observed** records (departing now), one per direction per run, by Pacific calendar month |
| `data/history/index.json` | List of available months |
| `data/forecasts/YYYY-MM.json` | Forecast log, now off (`collection.log_forecasts: false`). History keeps only the current drive time, both directions |
| `js/data.js` | Loading/shaping, plus `COMPARISON_RULES` / `typicalDuration()`: the hook for the historical comparison logic |
| `js/chart.js` | SVG chart; `Y_MODES` is where the planned "variance from normal" mode goes |

Observed record fields: `timestamp_utc` (when the request was actually made), `local_date`,
`local_hour`, `weekday` (America/Los_Angeles), `direction` (`A`/`B`), `duration_seconds`,
`static_duration_seconds`, `distance_meters`.

## Setup

1. **Google key.** In Google Cloud, enable the **Routes API**, create an API key, and
   restrict it to the Routes API. Set a budget alert (see cost below).
2. **GitHub secret.** Repo → Settings → Secrets and variables → Actions → New secret:
   `GOOGLE_MAPS_API_KEY`.
3. **Addresses.** Edit `routes.A/B.origin` and `destination` in `config.json`. They're
   currently city-level ("Mill Valley, CA", "Truckee, CA").
4. **First pull.** Actions → *Collect drive times* → *Run workflow*. Or locally:
   `GOOGLE_MAPS_API_KEY=… python3 scripts/collect.py`
5. **Pages.** Settings → Pages → Deploy from branch → `main` / root.
6. **iPad.** Open the Pages URL in Safari → Share → *Add to Home Screen* (opens full-screen).
   Settings → Display & Brightness → Auto-Lock → **Never**. Optionally use Guided Access
   to lock it to the app.

## How it behaves

- "Now" is the vertical line at dead centre. Left of it: observed (solid line, dots
  per reading). Right of it: Google's forecast (dashed, hollow markers).
- The dotted line is the latest no-traffic baseline (`staticDuration`).
- The ringed point is the **best departure in view**. Forecast points win because
  they're actionable. If only past data is in view, it's labelled "Lowest" instead.
- Swipe to pan back up to 48h. Pinch or tap 6h/24h/48h to zoom. Tap a point to read it.
  After 90s idle it snaps back to the default 6h, now-centred view.
- Re-fetches `latest.json` every 5 min, history every 30 min, and reloads the page every 6h.
- A yellow banner appears if the data is more than 3h old, the fetch fails, or some
  API requests failed on the last run.
- Gaps longer than 2.5h (skipped cron runs) break the line instead of bridging it.

## API choice and cost

`POST https://routes.googleapis.com/directions/v2:computeRoutes`, `travelMode: DRIVE`,
`routingPreference: TRAFFIC_AWARE_OPTIMAL`, `trafficModel: BEST_GUESS`, field mask
`routes.duration,routes.staticDuration,routes.distanceMeters`. "Now" omits `departureTime`
(the API then uses the request time). +1/+2/+3h send an explicit future `departureTime`.

Any traffic-aware request bills as **Compute Routes Pro**: 5,000 free per month, then
$10 per 1,000 (Google pricing as of Nov 2026). Volume is 2 directions × 3 departure times
(now, +1h, +2h) × 24 runs ≈ **4,380 requests/month**, inside the free tier. Adding `+3`
back to `forecast_offsets_hours` makes it ≈5,840/month, about $8–9/month. `computeRouteMatrix` is billed per element at the same rate, so it
isn't cheaper.

## Scheduling

- GitHub's plain hourly cron fired only about every 8 hours for this repo. So each
  workflow run now stays alive ~5.5 hours, collecting at :17 past every hour, then
  starts the next run itself (`gh workflow run`). Actions minutes are free on a public repo.
- The `17 * * * *` cron stays as a backstop that restarts the chain if it breaks.
- A reading is skipped if the last one is under 50 minutes old, so overlapping or manual
  runs never double up on API calls.
- To stop collection: disable the workflow in the Actions tab (cancelling one run only
  pauses it until the next cron fires).
- Each record stores the real request time, and the chart tolerates gaps. The 3h
  stale-data banner is the backstop: if it appears, check the Actions tab.

## Open questions

- Which days count as comparable for the historical view? (Add a rule to `COMPARISON_RULES`.)
- Exact origin/destination addresses.
- Public vs. private repo. (Pages on a private repo needs a paid plan. The 60-day rule
  applies only to public repos.)
- Snow/chain controls (e.g. Caltrans) as a separate data source later?

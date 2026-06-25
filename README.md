# Bangor River Level — GitHub Pages App

Real-time river level monitor for fishermen. Pulls 15-minute EPA HydroNet CSV
data, converts to local gauge, shows history graph with selectable window,
interpolates to the current moment, and projects a short-term forecast.

-----

## File Structure

```
bangor-river/
├── index.html              ← Single-page app
├── manifest.json           ← PWA (add to home screen)
├── css/
│   └── style.css
├── js/
│   ├── app.js              ← Data engine: ZIP fetch, CSV parse, interpolation, forecast
│   └── chart.js            ← Chart.js wrapper (history + forecast + NOW line)
├── cloudflare-worker.js    ← Deploy this for reliable CORS proxy (recommended)
└── README.md
```

-----

## Deploy to GitHub Pages

1. Create a GitHub repo (e.g. `bangor-river`)
1. Upload all files, preserving the `css/` and `js/` folders
1. **Settings → Pages → Deploy from branch → main / (root)**
1. Your app: `https://YOUR-USERNAME.github.io/bangor-river/`

**Add to phone:** Safari → Share → Add to Home Screen (runs full-screen, no browser chrome)

-----

## CORS Proxy Setup (Recommended — 2 minutes)

The app tries three free public proxies automatically, but they can be rate-limited.
For reliability, deploy the included Cloudflare Worker (free tier: 100k req/day).

### Steps:

1. Go to **https://workers.cloudflare.com** (free account, no credit card)
1. Click **Create Worker**
1. Paste the contents of `cloudflare-worker.js`
1. Click **Save and Deploy**
1. Note your worker URL, e.g. `https://epa-proxy.your-name.workers.dev`

### Wire it up:

In `js/app.js`, find `CORS_PROXIES` and uncomment the first line:

```js
const CORS_PROXIES = [
  url => `https://epa-proxy.your-name.workers.dev?target=${encodeURIComponent(url)}`,  // ← uncomment & edit
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ...
];
```

The worker caches the ZIP for 8 minutes and PNG for 5 minutes — well within
the EPA’s 15-minute update cycle.

-----

## How It Works

### Data Source

|Resource          |URL                                                                                                  |
|------------------|-----------------------------------------------------------------------------------------------------|
|**CSV data (ZIP)**|`https://epawebapp.epa.ie/Hydronet/output/internet/stations/CAS/33008/S/3_months.zip`                |
|**Overview PNG**  |`https://epawebapp.epa.ie/hydronet/output/internet/stations/CAS/33008/S/extralarge_3m_extralarge.png`|

The ZIP contains a CSV of 15-minute stage readings over the past 3 months
(~8,600 rows). It updates every 15 minutes on the EPA server.

### Processing Pipeline

```
Fetch ZIP → JSZip (unzip in browser) → Parse CSV → Sort readings
    → Interpolate to "now" (linear between bracketing 15-min points)
    → Linear regression over last 3h → Project +1h/+3h/+6h forecast
    → Cache in localStorage → Render
```

### Date/Time Parsing

The CSV parser handles multiple WISKI/Kisters formats automatically:

- `24.06.2026 16:45` (European, semicolon-delimited)
- `2026-06-24 16:45:00` (ISO, comma-delimited)
- `24.06.26 16:45` (2-digit year)

### Gauge Conversion

```
Gauge (m) = 14.664 × EPA_level(TBM) − 1452
```

### Current Level Interpolation

Since readings arrive every 15 minutes, the app:

1. Finds the two readings bracketing the current time
1. Linearly interpolates between them for a smooth “now” value
1. If current time is ahead of the last reading, extrapolates via the trend

### Forecast

Linear regression (least squares) over the most recent 3 hours of readings.
Projected forward at 15-minute steps to +6 hours.
Confidence shown as R² percentage — treat as indicative only.

### Auto-refresh

Data refreshes every **10 minutes**. The ↻ button forces an immediate refresh.
Previous data is cached in `localStorage` so the app works offline with
the last-known dataset.

-----

## Customisation

|Constant                |Location|Purpose                               |
|------------------------|--------|--------------------------------------|
|`GAUGE_A`, `GAUGE_B`    |`app.js`|Gauge conversion coefficients         |
|`GAUGE_MIN`, `GAUGE_MAX`|`app.js`|Tide-bar visual range                 |
|`TREND_WINDOW_H`        |`app.js`|Hours used for regression (default 3h)|
|`REFRESH_MS`            |`app.js`|Auto-refresh interval (default 10 min)|

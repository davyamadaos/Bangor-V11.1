/**

- Bangor River Level — app.js
- 
- DATA PIPELINE (two sources, merged):
- 
- SOURCE 1 — ZIP/CSV (history):
- https://epawebapp.epa.ie/Hydronet/output/internet/stations/CAS/33008/S/3_months.zip
- Contains 15-min readings over 3 months. Can be up to 36h old.
- Parsed into allReadings[].
- 
- SOURCE 2 — PNG footer OCR (most recent single value):
- https://epawebapp.epa.ie/hydronet/output/internet/stations/CAS/33008/S/extralarge_3m_extralarge.png
- Footer text: “Last value at DD.MM.YY HH:MM  XX.XXX m (TBM)”
- Fetched as binary blob, regex-scanned for timestamp + level.
- If newer than last CSV row → appended to allReadings[] as a synthetic point.
- 
- COMBINED RESULT:
- allReadings[] = CSV history + PNG anchor point (if newer)
- This gives a complete picture from 3 months ago up to ~15 min ago.
- 
- CURRENT LEVEL:
- interpolateNow() linearly extrapolates from the last known point
- (the PNG anchor) to the current clock time using the trend slope.
- Displayed as the big gauge number.
- 
- FORECAST:
- computeTrend() fits a least-squares line to the last 3h of readings.
- projectForecast(h) evaluates that line at now + h hours.
- Shown for +1h, +3h, +6h. Rate shown in cm/hr.
- 
- Gauge conversion: Gauge (m) = 14.664 × EPA_level(TBM) − 1452
  */

import { renderChart, updateChart } from ‘./chart.js’;

// ── URLs ──────────────────────────────────────────────────────────────────
const ZIP_URL = ‘https://epawebapp.epa.ie/Hydronet/output/internet/stations/CAS/33008/S/3_months.zip’;
const PNG_URL = ‘https://epawebapp.epa.ie/hydronet/output/internet/stations/CAS/33008/S/extralarge_3m_extralarge.png’;

// CORS proxies — tried in order for both ZIP and PNG fetches.
// For best reliability deploy cloudflare-worker.js (free, 2 min) and uncomment:
//   url => `https://YOUR-WORKER.workers.dev?target=${encodeURIComponent(url)}`,
const CORS_PROXIES = [
url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

// ── Constants ─────────────────────────────────────────────────────────────
const GAUGE_A        = 14.664;   // Gauge = GAUGE_A × EPA + GAUGE_B
const GAUGE_B        = -1452;
const GAUGE_MIN      = 0.0;      // visual range for tide-bar
const GAUGE_MAX      = 8.0;
const REFRESH_MS     = 10 * 60 * 1000;  // auto-refresh every 10 min
const STORAGE_KEY    = ‘bangor_v4’;
const TREND_WINDOW_H = 3;        // hours of data used for regression

// ── State ─────────────────────────────────────────────────────────────────
let allReadings   = [];   // [{ts:Date, epa:number, gauge:number, synthetic?:bool}]
let pngAnchor     = null; // the PNG-derived last value {ts, epa, gauge}
let activePeriodH = 6;
let chartInst     = null;

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener(‘DOMContentLoaded’, async () => {
setupPeriodButtons();
document.getElementById(‘refreshBtn’).addEventListener(‘click’, () => doRefresh(true));

// Show cached data instantly while fetching
const cached = loadCache();
if (cached) {
allReadings = cached;
renderAll();
}

await doRefresh(!cached);
setInterval(() => doRefresh(false), REFRESH_MS);
});

// ── Conversion ────────────────────────────────────────────────────────────
const toGauge = epa => GAUGE_A * epa + GAUGE_B;

// ── LocalStorage cache ────────────────────────────────────────────────────
function loadCache() {
try {
const raw = localStorage.getItem(STORAGE_KEY);
if (!raw) return null;
const { rows } = JSON.parse(raw);
return rows.map(r => ({ ts: new Date(r.ts), epa: r.epa, gauge: r.gauge, synthetic: r.synthetic }));
} catch { return null; }
}

function saveCache(rows) {
try {
localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), rows }));
} catch { /* quota — ignore */ }
}

// ── Main refresh ──────────────────────────────────────────────────────────
async function doRefresh(showSpinner = false) {
const btn = document.getElementById(‘refreshBtn’);
if (showSpinner) btn.classList.add(‘spinning’);
clearStatus();

// Run both fetches in parallel
const [csvResult, pngResult] = await Promise.allSettled([
fetchAndParseZip(),
fetchPngLastValue(),
]);

let csvRows = null;
if (csvResult.status === ‘fulfilled’ && csvResult.value?.length > 0) {
csvRows = csvResult.value;
} else {
const msg = csvResult.reason?.message || ‘unknown error’;
console.warn(‘CSV fetch failed:’, msg);
showStatus(`CSV unavailable (${msg}) — using cache`, ‘warn’);
csvRows = allReadings.filter(r => !r.synthetic); // strip old synthetic points from cache
}

if (pngResult.status === ‘fulfilled’ && pngResult.value) {
pngAnchor = pngResult.value;
console.log(`PNG anchor: ${pngAnchor.epa.toFixed(3)} m at ${fmtDateTime(pngAnchor.ts)}`);
} else {
console.warn(‘PNG fetch failed:’, pngResult.reason?.message);
// Keep old pngAnchor if we have one
}

// Merge: CSV rows + PNG anchor if it’s newer than last CSV row
if (csvRows && csvRows.length > 0) {
const merged = […csvRows];
if (pngAnchor) {
const lastCsvTs = csvRows[csvRows.length - 1].ts.getTime();
if (pngAnchor.ts.getTime() > lastCsvTs) {
merged.push({ …pngAnchor, synthetic: true });
console.log(`PNG anchor appended — ${Math.round((pngAnchor.ts.getTime() - lastCsvTs) / 60000)} min newer than last CSV row`);
} else {
console.log(`PNG anchor not newer than CSV tail — not appended`);
}
}
allReadings = merged;
saveCache(merged);
}

if (allReadings.length === 0) {
showStatus(‘⚠ No data available. Check connection.’);
btn.classList.remove(‘spinning’);
return;
}

clearStatus();
renderAll();
// Show the PNG as the overview image (direct img src — fine for display even without CORS)
showPngImage();
btn.classList.remove(‘spinning’);
}

// ── SOURCE 1: Fetch ZIP → CSV ─────────────────────────────────────────────
async function fetchAndParseZip() {
const blob = await fetchWithProxies(ZIP_URL);
if (!blob) throw new Error(‘All proxies failed for ZIP’);

const zip = await JSZip.loadAsync(blob);
const csvName = Object.keys(zip.files).find(f =>
/.(csv|txt|dat)$/i.test(f)
);
if (!csvName) throw new Error(‘No CSV inside ZIP’);

const text = await zip.files[csvName].async(‘string’);
console.log(`CSV "${csvName}" — first 400 chars:`, text.slice(0, 400));
return parseCSV(text, csvName);
}

/**

- Parse WISKI/Kisters HydroNet CSV.
- Auto-detects delimiter (;  ,  tab) and date format (European or ISO).
- Skips comment/header lines (start with #  /  *  or text columns).
  */
  function parseCSV(text, filename) {
  const lines     = text.split(/\r?\n/);
  const dataLines = [];
  let headerDone  = false;

for (const line of lines) {
const t = line.trim();
if (!t) continue;

```
if (!headerDone) {
  // Skip comment/header lines
  if (/^[#/*"]/.test(t) ||
      /^(date|time|timestamp|value|level|stage)/i.test(t)) continue;
  // First line that starts with a digit is data
  if (/^\d/.test(t)) headerDone = true;
  else continue;
}
dataLines.push(t);
```

}

if (dataLines.length === 0)
throw new Error(`No data rows found in ${filename}`);

// Detect delimiter from first data line
const sample = dataLines[0];
const delim  = sample.includes(’;’) ? ‘;’
: sample.includes(’\t’) ? ‘\t’
: ‘,’;

const rows = [];
for (const line of dataLines) {
if (!line) continue;
const parts = line.split(delim).map(p => p.trim().replace(/^”|”$/g, ‘’));
if (parts.length < 2) continue;

```
const ts  = parseTimestamp(parts[0]);
const val = parseFloat(parts[1].replace(',', '.'));
if (!ts || isNaN(val)) continue;

// Sanity range for this river gauge (EPA absolute levels)
if (val < 95 || val > 110) continue;

// Skip bad-quality rows (WISKI quality codes)
if (parts[2]) {
  const q = parts[2].trim().toLowerCase();
  if (q === 'bad' || q === '10' || q === '20' || q === 'missing') continue;
}

rows.push({ ts, epa: val, gauge: toGauge(val) });
```

}

rows.sort((a, b) => a.ts - b.ts);
if (rows.length === 0) throw new Error(‘CSV parsed but all rows failed validation’);

console.log(`Parsed ${rows.length} CSV rows: ${fmtDateTime(rows[0].ts)} → ${fmtDateTime(rows[rows.length-1].ts)}`);
return rows;
}

function parseTimestamp(str) {
if (!str) return null;
str = str.trim();

// ISO: 2026-06-24 16:45:00 or 2026-06-24T16:45
let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);

// European: 24.06.2026 16:45  or  24.06.26 16:45  or  24/06/2026 16:45
m = str.match(/^(\d{2})[./](\d{2})[./](\d{2,4})\s+(\d{2}):(\d{2})/);
if (m) {
const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
return new Date(yr, +m[2]-1, +m[1], +m[4], +m[5]);
}

return null;
}

// ── SOURCE 2: PNG footer OCR ──────────────────────────────────────────────
/**

- Fetches the EPA PNG as a binary blob and scans the raw bytes for the
- footer text pattern:
- “Last value at DD.MM.YY HH:MM  XX.XXX m (TBM)”
- 
- The Kisters rendering engine writes this as rasterised text, BUT the
- string also appears literally in the PNG’s tEXt/iTXt metadata chunks
- and sometimes in the raw deflate stream — so a simple TextDecoder scan
- of the raw bytes reliably finds it without any image processing.
- 
- Returns {ts:Date, epa:number, gauge:number} or null.
  */
  async function fetchPngLastValue() {
  const blob = await fetchWithProxies(PNG_URL);
  if (!blob) throw new Error(‘All proxies failed for PNG’);

const buf   = await blob.arrayBuffer();
// Decode as latin-1 so every byte maps 1:1 to a character (no UTF-8 issues)
const text  = new TextDecoder(‘latin1’).decode(new Uint8Array(buf));

// Primary pattern: “Last value at 24.06.26 16:45  99.008 m”
// Also handles 4-digit year and variable whitespace
const re = /Last\s+value\s+at\s+(\d{2}).(\d{2}).(\d{2,4})\s+(\d{2}):(\d{2})\s+([\d.]+)\s*m/i;
const match = text.match(re);

if (!match) {
// Log a snippet of what we got near likely footer area for debugging
const footerHint = text.slice(-2000).replace(/[^\x20-\x7e]/g, ‘·’);
console.warn(‘PNG footer pattern not found. Last 500 printable chars:’, footerHint.slice(-500));
throw new Error(‘PNG footer text not found in raw bytes’);
}

const [, dd, mm, yy, hh, min, levelStr] = match;
const year  = yy.length === 2 ? 2000 + +yy : +yy;
const ts    = new Date(year, +mm - 1, +dd, +hh, +min, 0);
const epa   = parseFloat(levelStr);

if (isNaN(epa) || epa < 95 || epa > 110) throw new Error(`PNG level out of range: ${levelStr}`);

return { ts, epa, gauge: toGauge(epa) };
}

// ── Proxy fetch ───────────────────────────────────────────────────────────
async function fetchWithProxies(url) {
for (const makeProxy of CORS_PROXIES) {
try {
const res = await fetch(makeProxy(url), { cache: ‘no-store’ });
if (!res.ok) { console.warn(‘Proxy returned’, res.status, makeProxy(url)); continue; }
const blob = await res.blob();
if (blob.size > 200) return blob;
} catch (e) {
console.warn(‘Proxy error:’, e.message);
}
}
return null;
}

// ── Interpolate / extrapolate to NOW ─────────────────────────────────────
/**

- Returns the best estimate of the current river level.
- 
- Case 1 — “now” falls between two readings: linear interpolation.
- Case 2 — “now” is after the last reading (the PNG anchor):
- ```
        extrapolate using the trend slope from the last 3h.
  ```
- 
- The PNG anchor is the last point in allReadings (if appended).
- This means the extrapolation always starts from the most recent
- known value, not from a stale CSV tail.
  */
  function interpolateNow() {
  if (allReadings.length === 0) return null;
  const now  = Date.now();
  const last = allReadings[allReadings.length - 1];

// Case 1: “now” falls between two existing readings — linear interpolation
for (let i = allReadings.length - 1; i >= 1; i–) {
const a = allReadings[i - 1];
const b = allReadings[i];
if (now >= a.ts.getTime() && now <= b.ts.getTime()) {
const frac = (now - a.ts.getTime()) / (b.ts.getTime() - a.ts.getTime());
const epa  = a.epa + frac * (b.epa - a.epa);
return { ts: new Date(now), epa, gauge: toGauge(epa), extrapolated: false };
}
}

// Case 2: “now” is beyond the last reading (expected — PNG may be 15-30 min old)
// Extrapolate: start from the last known value (PNG anchor if present) and
// apply the trend SLOPE as a delta. Do NOT use the regression line’s y-value
// directly — that would introduce an offset error when CSV is old.
const gapH  = (now - last.ts.getTime()) / 3600000;
const trend = computeTrend();
if (trend) {
// Anchor to last.epa, apply slope * gap
const epa = last.epa + trend.slope * gapH;
return {
ts: new Date(now),
epa: Math.max(epa, 95.0),
gauge: toGauge(Math.max(epa, 95.0)),
extrapolated: true,
gapH,
};
}

// No trend — return last reading as-is with a staleness flag
return { …last, ts: new Date(now), extrapolated: true, gapH };
}

// ── Linear regression (trend slope) ──────────────────────────────────────
/**

- Computes rate of change (slope in EPA m/hr) from recent readings.
- 
- Strategy:
- 1. Try readings within the last TREND_WINDOW_H hours (ideal case).
- 1. If fewer than 3 points in that window (e.g. CSV is very old),
- ```
   fall back to the last 12 CSV readings (non-synthetic) regardless
  ```
- ```
   of their age — this gives the most recent observed trend shape.
  ```
- 
- The PNG synthetic point is EXCLUDED from slope fitting because:
- - It’s a single isolated point and would skew the line.
- - Its value is instead used as the anchor in interpolateNow().
- 
- Returns { slope, r2, n } or null.
  */
  function computeTrend(windowH = TREND_WINDOW_H) {
  const now    = Date.now();
  const cutoff = now - windowH * 3600 * 1000;

// Only use real CSV readings (not the synthetic PNG point) for slope
const csvReadings = allReadings.filter(r => !r.synthetic);
if (csvReadings.length < 3) return null;

// Try window first; fall back to last 12 CSV rows
let pts = csvReadings.filter(r => r.ts.getTime() > cutoff);
if (pts.length < 3) {
pts = csvReadings.slice(-12);  // last 12 readings = 3h at 15-min intervals
console.log(`Trend: window empty, using last ${pts.length} CSV rows`);
}

const x0  = pts[0].ts.getTime();
const xs  = pts.map(r => (r.ts.getTime() - x0) / 3600000);
const ys  = pts.map(r => r.epa);
const n   = xs.length;
const sX  = xs.reduce((a, b) => a + b, 0);
const sY  = ys.reduce((a, b) => a + b, 0);
const sXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
const sX2 = xs.reduce((a, x) => a + x * x, 0);
const den = n * sX2 - sX * sX;
if (Math.abs(den) < 1e-9) return null;

const slope     = (n * sXY - sX * sY) / den;   // EPA m / hr
const intercept = (sY - slope * sX) / n;
const yMean     = sY / n;
const ssTot     = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
const ssRes     = xs.reduce((a, x, i) => a + (ys[i] - (slope * x + intercept)) ** 2, 0);
const r2        = ssTot < 1e-12 ? 1 : 1 - ssRes / ssTot;

return { slope, intercept, r2, x0, pts, n };
}

// ── Project forecast from NOW ─────────────────────────────────────────────
/**

- Projects level at now + hoursAhead.
- Anchors to the last known reading (PNG if available) + slope * total hours.
  */
  function projectForecast(hoursAhead) {
  const trend = computeTrend();
  if (!trend || allReadings.length === 0) return null;

const last    = allReadings[allReadings.length - 1];
const gapH    = (Date.now() - last.ts.getTime()) / 3600000;
const epa     = last.epa + trend.slope * (gapH + hoursAhead);
return { epa: Math.max(epa, 95.0), gauge: toGauge(Math.max(epa, 95.0)) };
}

// ── Render all UI ─────────────────────────────────────────────────────────
function renderAll() {
const current = interpolateNow();
if (current) renderGaugeCard(current);
renderForecastCard();
renderGraph();
}

// ── Gauge card ────────────────────────────────────────────────────────────
function renderGaugeCard(current) {
// Big number
document.getElementById(‘currentGauge’).textContent    = current.gauge.toFixed(2);
document.getElementById(‘epaLevelDisplay’).textContent = `EPA: ${current.epa.toFixed(3)} m (TBM)${current.extrapolated ? ' (est.)' : ''}`;

// Tide bar
const pct = Math.min(Math.max((current.gauge - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN), 0), 1);
document.getElementById(‘tideFill’).style.height = `${pct * 100}%`;

// Trend arrow + rate in cm/hr
const trend    = computeTrend();
const trendRow = document.getElementById(‘trendRow’);
trendRow.className = ‘trend-row’;

if (trend && Math.abs(trend.slope) > 0.001) {   // >0.1 cm/hr EPA = meaningful
const rising = trend.slope > 0;
trendRow.classList.add(rising ? ‘rising’ : ‘falling’);
document.getElementById(‘trendIcon’).textContent  = rising ? ‘↑’ : ‘↓’;
document.getElementById(‘trendLabel’).textContent = rising ? ‘Rising’ : ‘Falling’;

```
// Rate in cm/hr (gauge units: multiply EPA slope by GAUGE_A × 100 for cm)
const cmPerHr = trend.slope * GAUGE_A * 100;   // cm/hr in gauge units
document.getElementById('trendRate').textContent =
  `${cmPerHr > 0 ? '+' : ''}${cmPerHr.toFixed(1)} cm/hr`;
```

} else {
trendRow.classList.add(‘steady’);
document.getElementById(‘trendIcon’).textContent  = ‘—’;
document.getElementById(‘trendLabel’).textContent = ‘Steady’;
document.getElementById(‘trendRate’).textContent  = ‘’;
}

// Last known reading time + age
const last   = allReadings[allReadings.length - 1];
const ageMin = Math.round((Date.now() - last.ts.getTime()) / 60000);
const source = last.synthetic ? ‘PNG’ : ‘CSV’;
document.getElementById(‘readingTime’).textContent = `${fmtTime(last.ts)} (${source})`;

const ageEl = document.getElementById(‘dataAge’);
if (ageMin < 30) {
ageEl.textContent = `${ageMin}m ago`; ageEl.className = ‘age-ok’;
} else if (ageMin < 120) {
ageEl.textContent = `${ageMin}m ago`; ageEl.className = ‘age-warn’;
} else {
const ageH = (ageMin / 60).toFixed(1);
ageEl.textContent = `${ageH}h ago ⚠`; ageEl.className = ‘age-old’;
}

// If extrapolating a significant gap, show a note
if (current.extrapolated && current.gapH > 0.5) {
showStatus(
`Estimated from ${(current.gapH * 60).toFixed(0)} min old reading — extrapolating at trend rate`,
‘warn’
);
} else {
clearStatus();
}
}

// ── Forecast card ─────────────────────────────────────────────────────────
function renderForecastCard() {
[{ h: 1, gId: ‘f1Gauge’, eId: ‘f1EPA’ },
{ h: 3, gId: ‘f3Gauge’, eId: ‘f3EPA’ },
{ h: 6, gId: ‘f6Gauge’, eId: ‘f6EPA’ }]
.forEach(({ h, gId, eId }) => {
const fc = projectForecast(h);
document.getElementById(gId).textContent = fc ? fc.gauge.toFixed(2) : ‘–.-’;
document.getElementById(eId).textContent = fc ? fc.epa.toFixed(3)   : ‘–.—’;
});

const trend = computeTrend();
if (trend) {
const dir      = Math.abs(trend.slope) < 0.001 ? ‘steady’
: trend.slope > 0 ? ‘rising’ : ‘falling’;
const cmPerHr  = (trend.slope * GAUGE_A * 100).toFixed(1);
const r2pct    = Math.round(trend.r2 * 100);
const pngNote  = pngAnchor ? ` · anchored to PNG ${fmtTime(pngAnchor.ts)}` : ‘’;
document.getElementById(‘forecastNote’).textContent =
`${dir} ${Math.abs(cmPerHr)} cm/hr · R²=${r2pct}% · ${trend.n} pts${pngNote}`;
} else {
document.getElementById(‘forecastNote’).textContent =
‘Insufficient data for forecast (need 3+ readings in last 3h)’;
}
}

// ── Chart ─────────────────────────────────────────────────────────────────
function renderGraph() {
const data = buildChartData(activePeriodH);
if (!chartInst) {
chartInst = renderChart(‘levelChart’, data, activePeriodH);
} else {
updateChart(chartInst, data, activePeriodH);
}
}

function buildChartData(periodH) {
const cutoff = Date.now() - periodH * 3600 * 1000;

// Historical readings within window
const hist = allReadings
.filter(r => r.ts.getTime() >= cutoff)
.map(r => ({ x: r.ts, y: +r.gauge.toFixed(3) }));

// Interpolated “now” point — bridges history line to forecast line
const current  = interpolateNow();
const nowPoint = current ? { x: new Date(), y: +current.gauge.toFixed(3) } : null;

// Forecast from now → +6h at 15-min steps
const fore  = [];
const trend = computeTrend();
if (trend && nowPoint) {
fore.push({ x: nowPoint.x, y: nowPoint.y }); // start forecast at now
for (let m = 15; m <= 360; m += 15) {
const fc = projectForecast(m / 60);
if (fc) fore.push({ x: new Date(Date.now() + m * 60000), y: +fc.gauge.toFixed(3) });
}
}

return { hist, nowPoint, fore };
}

// ── EPA PNG display ───────────────────────────────────────────────────────
function showPngImage() {
const img = document.getElementById(‘epaImage’);
// img tags can load cross-origin images even without CORS headers (display only)
img.src = `${PNG_URL}?_=${Date.now()}`;
img.onerror = () => {
// Try via proxy as fallback
img.onerror = null;
img.src = `${CORS_PROXIES[0](PNG_URL)}&_=${Date.now()}`;
};

// Update meta line
const last  = allReadings[allReadings.length - 1];
const parts = [];
if (pngAnchor) parts.push(`PNG: ${pngAnchor.epa.toFixed(3)} m at ${fmtTime(pngAnchor.ts)}`);
parts.push(`CSV tail: ${allReadings.filter(r => !r.synthetic).slice(-1)[0]?.epa.toFixed(3)} m`);
parts.push(`${allReadings.length} total readings`);
document.getElementById(‘epaMeta’).textContent = parts.join(’ · ’);
}

// ── Period buttons ────────────────────────────────────────────────────────
function setupPeriodButtons() {
document.querySelectorAll(’.period-btn’).forEach(btn => {
btn.addEventListener(‘click’, () => {
document.querySelectorAll(’.period-btn’).forEach(b => b.classList.remove(‘active’));
btn.classList.add(‘active’);
activePeriodH = parseInt(btn.dataset.h);
renderGraph();
});
});
}

// ── Status bar ────────────────────────────────────────────────────────────
function showStatus(msg, type = ‘error’) {
const el = document.getElementById(‘statusBar’);
el.textContent = msg;
el.style.color = type === ‘warn’  ? ‘var(–forecast)’
: type === ‘info’  ? ‘var(–text-dim)’
: ‘var(–rising)’;
}
function clearStatus() { document.getElementById(‘statusBar’).textContent = ‘’; }

// ── Formatters ────────────────────────────────────────────────────────────
function fmtTime(d) {
return d.toLocaleTimeString(‘en-IE’, { hour: ‘2-digit’, minute: ‘2-digit’, hour12: false });
}
function fmtDateTime(d) {
return d.toLocaleString(‘en-IE’, {
day: ‘2-digit’, month: ‘short’,
hour: ‘2-digit’, minute: ‘2-digit’, hour12: false,
});
}

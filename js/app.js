/**

- Bangor River Level — app.js  (single-file bundle, no ES modules)
- 
- DATA PIPELINE:
- 1. Fetch 3_months.zip via CORS proxy → JSZip → parse CSV → history[]
- 1. Fetch PNG via CORS proxy → scan raw bytes for footer text → pngAnchor
- 1. If pngAnchor is newer than last CSV row → append to allReadings[]
- 1. interpolateNow()  → extrapolate from PNG anchor using trend slope
- 1. computeTrend()   → linear regression on last 3h of CSV rows
- 1. projectForecast() → anchor + slope × hours ahead
- 
- Gauge = 14.664 × EPA_level(TBM) − 1452
  */

// ── Debug panel ────────────────────────────────────────────────────────────
function dbg(msg) {
const p = document.getElementById(‘debugPanel’);
if (!p) return;
p.style.display = ‘block’;
const t = new Date().toLocaleTimeString(‘en-IE’, { hour12: false });
p.textContent += t + ’  ’ + msg + ‘\n’;
console.log(msg);
}

// ── URLs ───────────────────────────────────────────────────────────────────
var ZIP_URL = ‘https://epawebapp.epa.ie/Hydronet/output/internet/stations/CAS/33008/S/3_months.zip’;
var PNG_URL = ‘https://epawebapp.epa.ie/hydronet/output/internet/stations/CAS/33008/S/extralarge_3m_extralarge.png’;

// CORS proxies — tried in order for both ZIP and PNG.
// Deploy cloudflare-worker.js (free) and add your worker URL as first entry:
//   function(url){ return ‘https://YOUR-WORKER.workers.dev?target=’ + encodeURIComponent(url); },
var CORS_PROXIES = [
function(url){ return ‘https://api.allorigins.win/raw?url=’ + encodeURIComponent(url); },
function(url){ return ‘https://corsproxy.io/?’ + encodeURIComponent(url); },
function(url){ return ‘https://api.codetabs.com/v1/proxy?quest=’ + encodeURIComponent(url); },
];

// ── Constants ──────────────────────────────────────────────────────────────
var GAUGE_A        = 14.664;
var GAUGE_B        = -1452;
var GAUGE_MIN      = 0.0;
var GAUGE_MAX      = 8.0;
var REFRESH_MS     = 10 * 60 * 1000;
var STORAGE_KEY    = ‘bangor_v4’;
var TREND_WINDOW_H = 3;

// ── State ──────────────────────────────────────────────────────────────────
var allReadings   = [];
var pngAnchor     = null;
var activePeriodH = 6;
var chartInst     = null;

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener(‘DOMContentLoaded’, function() {
dbg(‘Page loaded. Starting up…’);
setupPeriodButtons();
document.getElementById(‘refreshBtn’).addEventListener(‘click’, function() { doRefresh(true); });

var cached = loadCache();
if (cached) {
dbg(‘Cache found: ’ + cached.length + ’ readings’);
allReadings = cached;
renderAll();
} else {
dbg(‘No cache found’);
}

doRefresh(!cached);
scheduleNextRefresh();
});

function scheduleNextRefresh() {
var msIn15      = 15 * 60 * 1000;
var elapsed     = Date.now() % msIn15;
var msUntilNext = (msIn15 - elapsed) + 75000; // 75s after next 15-min boundary
dbg(‘Next auto-refresh in ’ + Math.round(msUntilNext / 60000) + ’ min’);
setTimeout(function() {
doRefresh(false);
scheduleNextRefresh();
}, msUntilNext);
}

// ── Conversion ─────────────────────────────────────────────────────────────
function toGauge(epa) { return GAUGE_A * epa + GAUGE_B; }

// ── Cache ──────────────────────────────────────────────────────────────────
function loadCache() {
try {
var raw = localStorage.getItem(STORAGE_KEY);
if (!raw) return null;
var parsed = JSON.parse(raw);
return parsed.rows.map(function(r) {
return { ts: new Date(r.ts), epa: r.epa, gauge: r.gauge, synthetic: r.synthetic };
});
} catch(e) { return null; }
}

function saveCache(rows) {
try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), rows: rows })); }
catch(e) { dbg(’Cache save failed (quota?): ’ + e.message); }
}

// ── Main refresh ───────────────────────────────────────────────────────────
function doRefresh(showSpinner) {
var btn = document.getElementById(‘refreshBtn’);
if (showSpinner) btn.classList.add(‘spinning’);
clearStatus();
dbg(’— Refresh started —’);

var csvPromise = fetchAndParseZip();
var pngPromise = fetchPngLastValue();

Promise.allSettled([csvPromise, pngPromise]).then(function(results) {
var csvResult = results[0];
var pngResult = results[1];

```
// CSV result
var csvRows = null;
if (csvResult.status === 'fulfilled' && csvResult.value && csvResult.value.length > 0) {
  csvRows = csvResult.value;
  dbg('CSV OK: ' + csvRows.length + ' rows, last=' + fmtDateTime(csvRows[csvRows.length-1].ts));
} else {
  var csvErr = csvResult.reason ? csvResult.reason.message : 'unknown';
  dbg('CSV FAILED: ' + csvErr);
  showStatus('CSV unavailable: ' + csvErr, 'warn');
  csvRows = allReadings.filter(function(r) { return !r.synthetic; });
  if (csvRows.length > 0) dbg('Using ' + csvRows.length + ' cached CSV rows');
}

// PNG result
if (pngResult.status === 'fulfilled' && pngResult.value) {
  pngAnchor = pngResult.value;
  dbg('PNG OK: ' + pngAnchor.epa.toFixed(3) + ' m at ' + fmtDateTime(pngAnchor.ts));
} else {
  var pngErr = pngResult.reason ? pngResult.reason.message : 'unknown';
  dbg('PNG FAILED: ' + pngErr);
}

// Merge
if (csvRows && csvRows.length > 0) {
  var merged = csvRows.slice();
  if (pngAnchor) {
    var lastCsvTs = csvRows[csvRows.length - 1].ts.getTime();
    if (pngAnchor.ts.getTime() > lastCsvTs) {
      merged.push({ ts: pngAnchor.ts, epa: pngAnchor.epa, gauge: pngAnchor.gauge, synthetic: true });
      var diffMin = Math.round((pngAnchor.ts.getTime() - lastCsvTs) / 60000);
      dbg('PNG appended as anchor (' + diffMin + ' min newer than CSV tail)');
    } else {
      dbg('PNG not newer than CSV tail — not appended');
    }
  }
  allReadings = merged;
  saveCache(merged);
}

if (allReadings.length === 0) {
  showStatus('No data available. Check connection.', 'error');
  btn.classList.remove('spinning');
  return;
}

clearStatus();
renderAll();
showPngImage();
btn.classList.remove('spinning');
```

});
}

// ── SOURCE 1: ZIP / CSV ────────────────────────────────────────────────────
function fetchAndParseZip() {
dbg(‘Fetching ZIP…’);
return fetchWithProxies(ZIP_URL).then(function(blob) {
if (!blob) throw new Error(‘All proxies failed for ZIP’);
dbg(‘ZIP blob received: ’ + blob.size + ’ bytes — unzipping…’);
return JSZip.loadAsync(blob);
}).then(function(zip) {
var names = Object.keys(zip.files);
dbg(‘ZIP contents: ’ + names.join(’, ’));
var csvName = names.find(function(f) { return /.(csv|txt|dat)$/i.test(f); });
if (!csvName) throw new Error(‘No CSV found in ZIP. Files: ’ + names.join(’, ’));
dbg(’Reading CSV: ’ + csvName);
return zip.files[csvName].async(‘string’);
}).then(function(text) {
dbg(‘CSV text length: ’ + text.length + ’ chars’);
dbg(’CSV first 200 chars: ’ + text.slice(0, 200).replace(/\n/g, ‘↵’));
return parseCSV(text);
});
}

function parseCSV(text) {
var lines     = text.split(/\r?\n/);
var dataLines = [];
var headerDone = false;

for (var i = 0; i < lines.length; i++) {
var t = lines[i].trim();
if (!t) continue;
if (!headerDone) {
if (/^[#/*”]/.test(t) || /^(date|time|timestamp|value|level|stage)/i.test(t)) continue;
if (/^\d/.test(t)) headerDone = true;
else continue;
}
dataLines.push(t);
}

dbg(’CSV data lines: ’ + dataLines.length + (dataLines[0] ? ’ first: ’ + dataLines[0] : ‘’));

if (dataLines.length === 0) throw new Error(‘No data rows in CSV’);

var sample = dataLines[0];
var delim  = sample.indexOf(’;’) >= 0 ? ‘;’ : sample.indexOf(’\t’) >= 0 ? ‘\t’ : ‘,’;
dbg(’CSV delimiter: ’ + (delim === ‘;’ ? ‘semicolon’ : delim === ‘\t’ ? ‘tab’ : ‘comma’));

var rows = [];
for (var j = 0; j < dataLines.length; j++) {
var line  = dataLines[j];
if (!line) continue;
var parts = line.split(delim).map(function(p) { return p.trim().replace(/^”|”$/g, ‘’); });
if (parts.length < 2) continue;
var ts  = parseTimestamp(parts[0]);
var val = parseFloat(parts[1].replace(’,’, ‘.’));
if (!ts || isNaN(val) || val < 95 || val > 110) continue;
if (parts[2]) {
var q = parts[2].trim().toLowerCase();
if (q === ‘bad’ || q === ‘10’ || q === ‘20’ || q === ‘missing’) continue;
}
rows.push({ ts: ts, epa: val, gauge: toGauge(val) });
}

rows.sort(function(a, b) { return a.ts - b.ts; });
if (rows.length === 0) throw new Error(‘CSV parsed but 0 valid rows (check value range 95-110)’);
dbg(‘CSV parsed OK: ’ + rows.length + ’ rows’);
return rows;
}

function parseTimestamp(str) {
if (!str) return null;
str = str.trim();
var m;
// ISO: 2026-06-24 16:45 or 2026-06-24T16:45
m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);
// European: 24.06.2026 16:45  or  24.06.26 16:45  or  24/06/2026 16:45
m = str.match(/^(\d{2})[./](\d{2})[./](\d{2,4})\s+(\d{2}):(\d{2})/);
if (m) {
var yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
return new Date(yr, +m[2]-1, +m[1], +m[4], +m[5]);
}
return null;
}

// ── SOURCE 2: PNG footer OCR ───────────────────────────────────────────────
function fetchPngLastValue() {
dbg(‘Fetching PNG for footer OCR…’);
return fetchWithProxies(PNG_URL).then(function(blob) {
if (!blob) throw new Error(‘All proxies failed for PNG’);
dbg(‘PNG blob: ’ + blob.size + ’ bytes — scanning bytes…’);
return blob.arrayBuffer();
}).then(function(buf) {
var bytes = new Uint8Array(buf);
var text  = ‘’;
for (var i = 0; i < bytes.length; i++) {
text += String.fromCharCode(bytes[i]);
}
// Search for: “Last value at 24.06.26 16:45  99.008 m”
var re    = /Last\s+value\s+at\s+(\d{2}).(\d{2}).(\d{2,4})\s+(\d{2}):(\d{2})\s+([\d.]+)\s*m/i;
var match = text.match(re);
if (!match) {
// Log last 300 printable chars for debugging
var printable = text.slice(-1000).replace(/[^\x20-\x7e]/g, ‘’).slice(-300);
dbg(’PNG footer not found. Last printable: ’ + printable);
throw new Error(‘PNG footer text not found in raw bytes’);
}
var dd  = match[1], mm = match[2], yy = match[3];
var hh  = match[4], mn = match[5];
var lvl = match[6];
var yr  = yy.length === 2 ? 2000 + +yy : +yy;
var ts  = new Date(yr, +mm - 1, +dd, +hh, +mn, 0);
var epa = parseFloat(lvl);
if (isNaN(epa) || epa < 95 || epa > 110) throw new Error(’PNG level out of range: ’ + lvl);
dbg(’PNG footer found: ’ + epa.toFixed(3) + ’ m at ’ + fmtDateTime(ts));
return { ts: ts, epa: epa, gauge: toGauge(epa) };
});
}

// ── Proxy fetch ────────────────────────────────────────────────────────────
function fetchWithProxies(url) {
var proxies = CORS_PROXIES.slice();
function tryNext() {
if (proxies.length === 0) return Promise.resolve(null);
var makeProxy = proxies.shift();
var proxyUrl  = makeProxy(url);
dbg(’Trying proxy: ’ + proxyUrl.slice(0, 90));
return fetch(proxyUrl, { cache: ‘no-store’ })
.then(function(res) {
dbg(’Response: HTTP ’ + res.status);
if (!res.ok) { dbg(‘Not OK — trying next proxy’); return tryNext(); }
return res.blob().then(function(blob) {
dbg(‘Blob size: ’ + blob.size + ’ bytes’);
if (blob.size < 200) { dbg(‘Too small — trying next proxy’); return tryNext(); }
return blob;
});
})
.catch(function(e) {
dbg(‘Proxy error: ’ + e.message + ’ — trying next’);
return tryNext();
});
}
return tryNext();
}

// ── Interpolate to NOW ─────────────────────────────────────────────────────
function interpolateNow() {
if (allReadings.length === 0) return null;
var now  = Date.now();
var last = allReadings[allReadings.length - 1];

// Between two readings — linear interpolation
for (var i = allReadings.length - 1; i >= 1; i–) {
var a = allReadings[i - 1];
var b = allReadings[i];
if (now >= a.ts.getTime() && now <= b.ts.getTime()) {
var frac = (now - a.ts.getTime()) / (b.ts.getTime() - a.ts.getTime());
var epa  = a.epa + frac * (b.epa - a.epa);
return { ts: new Date(now), epa: epa, gauge: toGauge(epa), extrapolated: false };
}
}

// Beyond last reading — extrapolate from PNG anchor using trend slope
var gapH  = (now - last.ts.getTime()) / 3600000;
var trend = computeTrend();
if (trend) {
var epaExt = last.epa + trend.slope * gapH;
epaExt = Math.max(epaExt, 95.0);
return { ts: new Date(now), epa: epaExt, gauge: toGauge(epaExt), extrapolated: true, gapH: gapH };
}
return { ts: new Date(now), epa: last.epa, gauge: last.gauge, extrapolated: true, gapH: gapH };
}

// ── Trend regression ───────────────────────────────────────────────────────
function computeTrend() {
var csvOnly = allReadings.filter(function(r) { return !r.synthetic; });
if (csvOnly.length < 3) return null;

var cutoff = Date.now() - TREND_WINDOW_H * 3600 * 1000;
var pts    = csvOnly.filter(function(r) { return r.ts.getTime() > cutoff; });
if (pts.length < 3) {
pts = csvOnly.slice(-12);
dbg(‘Trend: fell back to last ’ + pts.length + ’ CSV rows’);
}

var x0  = pts[0].ts.getTime();
var xs  = pts.map(function(r) { return (r.ts.getTime() - x0) / 3600000; });
var ys  = pts.map(function(r) { return r.epa; });
var n   = xs.length;
var sX  = xs.reduce(function(a,b){return a+b;}, 0);
var sY  = ys.reduce(function(a,b){return a+b;}, 0);
var sXY = xs.reduce(function(a,x,i){return a+x*ys[i];}, 0);
var sX2 = xs.reduce(function(a,x){return a+x*x;}, 0);
var den = n * sX2 - sX * sX;
if (Math.abs(den) < 1e-9) return null;

var slope     = (n * sXY - sX * sY) / den;
var intercept = (sY - slope * sX) / n;
var yMean     = sY / n;
var ssTot = ys.reduce(function(a,y){return a+(y-yMean)*(y-yMean);}, 0);
var ssRes = xs.reduce(function(a,x,i){return a+Math.pow(ys[i]-(slope*x+intercept),2);}, 0);
var r2    = ssTot < 1e-12 ? 1 : 1 - ssRes / ssTot;

return { slope: slope, r2: r2, n: n };
}

function projectForecast(hoursAhead) {
var trend = computeTrend();
if (!trend || allReadings.length === 0) return null;
var last  = allReadings[allReadings.length - 1];
var gapH  = (Date.now() - last.ts.getTime()) / 3600000;
var epa   = last.epa + trend.slope * (gapH + hoursAhead);
return { epa: Math.max(epa, 95.0), gauge: toGauge(Math.max(epa, 95.0)) };
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderAll() {
var current = interpolateNow();
if (current) renderGaugeCard(current);
renderForecastCard();
renderGraph();
}

function renderGaugeCard(current) {
document.getElementById(‘currentGauge’).textContent    = current.gauge.toFixed(2);
document.getElementById(‘epaLevelDisplay’).textContent =
‘EPA: ’ + current.epa.toFixed(3) + ’ m (TBM)’ + (current.extrapolated ? ’ (est.)’ : ‘’);

var pct = Math.min(Math.max((current.gauge - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN), 0), 1);
document.getElementById(‘tideFill’).style.height = (pct * 100) + ‘%’;

var trend    = computeTrend();
var trendRow = document.getElementById(‘trendRow’);
trendRow.className = ‘trend-row’;

if (trend && Math.abs(trend.slope) > 0.001) {
var rising = trend.slope > 0;
trendRow.classList.add(rising ? ‘rising’ : ‘falling’);
document.getElementById(‘trendIcon’).textContent  = rising ? ‘↑’ : ‘↓’;
document.getElementById(‘trendLabel’).textContent = rising ? ‘Rising’ : ‘Falling’;
var cmPerHr = trend.slope * GAUGE_A * 100;
document.getElementById(‘trendRate’).textContent  =
(cmPerHr > 0 ? ‘+’ : ‘’) + cmPerHr.toFixed(1) + ’ cm/hr’;
} else {
trendRow.classList.add(‘steady’);
document.getElementById(‘trendIcon’).textContent  = ‘—’;
document.getElementById(‘trendLabel’).textContent = ‘Steady’;
document.getElementById(‘trendRate’).textContent  = ‘’;
}

var last   = allReadings[allReadings.length - 1];
var ageMin = Math.round((Date.now() - last.ts.getTime()) / 60000);
var src    = last.synthetic ? ‘PNG’ : ‘CSV’;
document.getElementById(‘readingTime’).textContent = fmtTime(last.ts) + ’ (’ + src + ‘)’;
var ageEl = document.getElementById(‘dataAge’);
if (ageMin < 30)       { ageEl.textContent = ageMin + ‘m ago’;                    ageEl.className = ‘age-ok’; }
else if (ageMin < 120) { ageEl.textContent = ageMin + ‘m ago’;                    ageEl.className = ‘age-warn’; }
else                   { ageEl.textContent = (ageMin/60).toFixed(1) + ‘h ago ⚠’; ageEl.className = ‘age-old’; }

if (current.extrapolated && current.gapH > 0.5) {
showStatus(‘Estimated — extrapolating from ’ + Math.round(current.gapH * 60) + ’ min old reading’, ‘warn’);
}
}

function renderForecastCard() {
var slots = [{h:1,g:‘f1Gauge’,e:‘f1EPA’},{h:3,g:‘f3Gauge’,e:‘f3EPA’},{h:6,g:‘f6Gauge’,e:‘f6EPA’}];
slots.forEach(function(s) {
var fc = projectForecast(s.h);
document.getElementById(s.g).textContent = fc ? fc.gauge.toFixed(2) : ‘–.-’;
document.getElementById(s.e).textContent = fc ? fc.epa.toFixed(3)   : ‘–.—’;
});
var trend = computeTrend();
if (trend) {
var dir      = Math.abs(trend.slope) < 0.001 ? ‘steady’ : trend.slope > 0 ? ‘rising’ : ‘falling’;
var cmPerHr  = Math.abs(trend.slope * GAUGE_A * 100).toFixed(1);
var r2pct    = Math.round(trend.r2 * 100);
var pngNote  = pngAnchor ? ’ · PNG ’ + fmtTime(pngAnchor.ts) : ‘’;
document.getElementById(‘forecastNote’).textContent =
dir + ’ ’ + cmPerHr + ’ cm/hr · R²=’ + r2pct + ‘% · ’ + trend.n + ’ pts’ + pngNote;
} else {
document.getElementById(‘forecastNote’).textContent = ‘Insufficient data for forecast’;
}
}

// ── Chart ──────────────────────────────────────────────────────────────────
function renderGraph() {
var data = buildChartData(activePeriodH);
if (!chartInst) {
chartInst = createChart(data, activePeriodH);
} else {
chartInst.data.datasets[0].data = buildHistDataset(data.hist, data.nowPoint);
chartInst.data.datasets[1].data = data.fore;
chartInst.options.scales.x.min  = xMin(activePeriodH);
chartInst.options.scales.x.max  = xMax(data.fore);
chartInst.options.plugins.nowLine.nowTs = data.nowPoint ? data.nowPoint.x.getTime() : Date.now();
chartInst.update(‘active’);
}
}

function buildHistDataset(hist, nowPoint) {
if (!nowPoint) return hist;
var last = hist[hist.length - 1];
if (!last || nowPoint.x > last.x) return hist.concat([nowPoint]);
return hist;
}

function buildChartData(periodH) {
var cutoff = Date.now() - periodH * 3600 * 1000;
var hist   = allReadings
.filter(function(r) { return r.ts.getTime() >= cutoff; })
.map(function(r) { return { x: r.ts, y: +r.gauge.toFixed(3) }; });

var current  = interpolateNow();
var nowPoint = current ? { x: new Date(), y: +current.gauge.toFixed(3) } : null;

var fore  = [];
var trend = computeTrend();
if (trend && nowPoint) {
fore.push({ x: nowPoint.x, y: nowPoint.y });
for (var m = 15; m <= 360; m += 15) {
var fc = projectForecast(m / 60);
if (fc) fore.push({ x: new Date(Date.now() + m * 60000), y: +fc.gauge.toFixed(3) });
}
}

return { hist: hist, nowPoint: nowPoint, fore: fore };
}

function xMin(periodH) { return new Date(Date.now() - periodH * 3600 * 1000); }
function xMax(fore)    {
if (fore && fore.length > 0) return fore[fore.length - 1].x;
return new Date(Date.now() + 3600 * 1000);
}

function createChart(data, periodH) {
var MONO = “‘IBM Plex Mono’, ‘Courier New’, monospace”;
var C = {
water: ‘#2196f3’, waterFill: ‘rgba(33,150,243,0.18)’,
forecast: ‘#f59e0b’, forecastFill: ‘rgba(245,158,11,0.10)’,
grid: ‘rgba(30,58,95,0.9)’, tick: ‘#3d5a7a’, label: ‘#7a9cbf’,
tooltipBg: ‘#0a1628’, tooltipBdr: ‘#1e3a5f’,
};

var nowTs    = data.nowPoint ? data.nowPoint.x.getTime() : Date.now();
var histData = buildHistDataset(data.hist, data.nowPoint);

var nowLinePlugin = {
id: ‘nowLine’,
afterDraw: function(chart) {
var ctx = chart.ctx;
var ca  = chart.chartArea;
var x   = chart.scales.x;
var ts  = chart.options.plugins.nowLine.nowTs || Date.now();
var nx  = x.getPixelForValue(ts);
if (nx < x.left || nx > x.right) return;
ctx.save();
ctx.beginPath();
ctx.moveTo(nx, ca.top); ctx.lineTo(nx, ca.bottom);
ctx.strokeStyle = ‘rgba(255,255,255,0.28)’;
ctx.lineWidth = 1.5; ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
ctx.fillStyle = ‘rgba(255,255,255,0.32)’;
ctx.font = ’9px ’ + MONO; ctx.textAlign = ‘center’; ctx.textBaseline = ‘top’;
ctx.fillText(‘NOW’, nx, ca.top + 4);
ctx.restore();
}
};

var ctx = document.getElementById(‘levelChart’).getContext(‘2d’);
return new Chart(ctx, {
type: ‘line’,
data: {
datasets: [
{
label: ‘Gauge (m)’, data: histData,
borderColor: C.water, backgroundColor: C.waterFill,
borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
fill: true, tension: 0.3, order: 2,
},
{
label: ‘Forecast’, data: data.fore,
borderColor: C.forecast, backgroundColor: C.forecastFill,
borderDash: [7,4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
fill: true, tension: 0.3, order: 1,
},
],
},
options: {
responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
interaction: { mode: ‘index’, intersect: false },
plugins: {
legend: { display: false },
nowLine: { nowTs: nowTs },
tooltip: {
backgroundColor: C.tooltipBg, borderColor: C.tooltipBdr, borderWidth: 1,
titleColor: C.label, bodyColor: ‘#e8f4fd’,
titleFont: { family: MONO, size: 10 }, bodyFont: { family: MONO, size: 12 }, padding: 10,
callbacks: {
title: function(items) { return fmtTooltipTime(new Date(items[0].parsed.x)); },
label: function(item) {
return (item.datasetIndex === 1 ? ‘⟢’ : ‘〜’) + ’  ’ + item.parsed.y.toFixed(3) + ’ m gauge’;
},
},
},
},
scales: {
x: {
type: ‘time’, min: xMin(periodH), max: xMax(data.fore),
time: { displayFormats: { minute: ‘HH:mm’, hour: ‘HH:mm’, day: ‘dd MMM’ } },
grid: { color: C.grid }, ticks: { color: C.tick, font: { family: MONO, size: 10 }, maxTicksLimit: 7, maxRotation: 0 },
border: { color: C.grid },
},
y: {
grid: { color: C.grid }, ticks: { color: C.tick, font: { family: MONO, size: 10 }, callback: function(v){ return v.toFixed(2); } },
border: { color: C.grid },
title: { display: true, text: ‘Gauge (m)’, color: C.label, font: { family: MONO, size: 10 } },
},
},
},
plugins: [nowLinePlugin],
});
}

// ── EPA PNG image display ───────────────────────────────────────────────────
function showPngImage() {
var img = document.getElementById(‘epaImage’);
img.src = PNG_URL + ‘?*=’ + Date.now();
img.onerror = function() {
img.onerror = null;
img.src = CORS_PROXIES[0](PNG_URL) + ’&*=’ + Date.now();
};
var last = allReadings[allReadings.length - 1];
var parts = [];
if (pngAnchor) parts.push(‘PNG: ’ + pngAnchor.epa.toFixed(3) + ’ m @ ’ + fmtTime(pngAnchor.ts));
var csvTail = allReadings.filter(function(r){return !r.synthetic;}).slice(-1)[0];
if (csvTail)  parts.push(‘CSV tail: ’ + csvTail.epa.toFixed(3) + ’ m’);
parts.push(allReadings.length + ’ readings’);
document.getElementById(‘epaMeta’).textContent = parts.join(’ · ’);
}

// ── Period buttons ──────────────────────────────────────────────────────────
function setupPeriodButtons() {
document.querySelectorAll(’.period-btn’).forEach(function(btn) {
btn.addEventListener(‘click’, function() {
document.querySelectorAll(’.period-btn’).forEach(function(b){ b.classList.remove(‘active’); });
btn.classList.add(‘active’);
activePeriodH = parseInt(btn.dataset.h);
renderGraph();
});
});
}

// ── Status ──────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
var el = document.getElementById(‘statusBar’);
el.textContent = msg;
el.style.color = type === ‘warn’ ? ‘var(–forecast)’ : type === ‘info’ ? ‘var(–text-dim)’ : ‘var(–rising)’;
}
function clearStatus() { document.getElementById(‘statusBar’).textContent = ‘’; }

// ── Formatters ───────────────────────────────────────────────────────────────
function fmtTime(d) {
return d.toLocaleTimeString(‘en-IE’, { hour: ‘2-digit’, minute: ‘2-digit’, hour12: false });
}
function fmtDateTime(d) {
return d.toLocaleString(‘en-IE’, { day: ‘2-digit’, month: ‘short’, hour: ‘2-digit’, minute: ‘2-digit’, hour12: false });
}
function fmtTooltipTime(d) {
return d.toLocaleString(‘en-IE’, { weekday: ‘short’, day: ‘numeric’, month: ‘short’, hour: ‘2-digit’, minute: ‘2-digit’, hour12: false });
}

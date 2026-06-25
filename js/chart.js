/**

- Bangor River Level — chart.js
- 
- Renders time-series with three connected segments:
- 1. Blue fill  — historical CSV readings (within selected window)
- 1. Blue line  — extended to the interpolated NOW point
- 1. Amber dash — forecast from NOW → +6h
- 
- A vertical “NOW” line marks the boundary between known and projected.
  */

const C = {
water:        ‘#2196f3’,
waterFill:    ‘rgba(33,150,243,0.18)’,
forecast:     ‘#f59e0b’,
forecastFill: ‘rgba(245,158,11,0.10)’,
grid:         ‘rgba(30,58,95,0.9)’,
tick:         ‘#3d5a7a’,
axisLabel:    ‘#7a9cbf’,
tooltipBg:    ‘#0a1628’,
tooltipBdr:   ‘#1e3a5f’,
tooltipTitle: ‘#7a9cbf’,
tooltipBody:  ‘#e8f4fd’,
nowLine:      ‘rgba(255,255,255,0.28)’,
};

const MONO = “‘IBM Plex Mono’, ‘Courier New’, monospace”;

// ── Public API ────────────────────────────────────────────────────────────
export function renderChart(canvasId, data, periodH) {
const ctx = document.getElementById(canvasId).getContext(‘2d’);
return new Chart(ctx, buildConfig(data, periodH));
}

export function updateChart(chart, data, periodH) {
const { histDataset, fore } = prepDatasets(data);
chart.data.datasets[0].data = histDataset;
chart.data.datasets[1].data = fore;
chart.options.scales.x.min  = xMin(periodH);
chart.options.scales.x.max  = xMax(fore, data.nowPoint);
chart.options.plugins.nowLine.nowTs = data.nowPoint?.x?.getTime() ?? Date.now();
chart.update(‘active’);
}

// ── Dataset preparation ───────────────────────────────────────────────────
function prepDatasets({ hist, nowPoint, fore }) {
// Append interpolated nowPoint to history so blue line reaches NOW
let histDataset = hist;
if (nowPoint) {
const last = hist[hist.length - 1];
if (!last || nowPoint.x > last.x) {
histDataset = […hist, nowPoint];
}
}
return { histDataset, fore };
}

// ── Chart config ──────────────────────────────────────────────────────────
function buildConfig(data, periodH) {
const { histDataset, fore } = prepDatasets(data);
const nowTs = data.nowPoint?.x?.getTime() ?? Date.now();

return {
type: ‘line’,
data: {
datasets: [
{
label:                    ‘Gauge (m)’,
data:                     histDataset,
borderColor:              C.water,
backgroundColor:          C.waterFill,
borderWidth:              2,
pointRadius:              0,
pointHoverRadius:         4,
pointHoverBackgroundColor: C.water,
fill:                     true,
tension:                  0.3,
order:                    2,
},
{
label:                    ‘Forecast’,
data:                     fore,
borderColor:              C.forecast,
backgroundColor:          C.forecastFill,
borderDash:               [7, 4],
borderWidth:              2,
pointRadius:              0,
pointHoverRadius:         4,
pointHoverBackgroundColor: C.forecast,
fill:                     true,
tension:                  0.3,
order:                    1,
},
],
},

```
options: {
  responsive:          true,
  maintainAspectRatio: false,
  animation:           { duration: 350 },
  interaction:         { mode: 'index', intersect: false },

  plugins: {
    legend: { display: false },

    tooltip: {
      backgroundColor: C.tooltipBg,
      borderColor:     C.tooltipBdr,
      borderWidth:     1,
      titleColor:      C.tooltipTitle,
      bodyColor:       C.tooltipBody,
      titleFont:       { family: MONO, size: 10 },
      bodyFont:        { family: MONO, size: 12 },
      padding:         10,
      callbacks: {
        title: items => fmtTooltipTime(new Date(items[0].parsed.x)),
        label: item => {
          const isFore = item.datasetIndex === 1;
          const icon   = isFore ? '⟢' : '〜';
          return `${icon}  ${item.parsed.y.toFixed(3)} m gauge`;
        },
      },
    },

    // Config object read by the custom nowLine plugin below
    nowLine: { nowTs },
  },

  scales: {
    x: {
      type: 'time',
      min:  xMin(periodH),
      max:  xMax(fore, data.nowPoint),
      time: {
        displayFormats: {
          minute: 'HH:mm',
          hour:   'HH:mm',
          day:    'EEE dd MMM',
        },
      },
      grid:   { color: C.grid, lineWidth: 1 },
      ticks:  {
        color:         C.tick,
        font:          { family: MONO, size: 10 },
        maxRotation:   0,
        maxTicksLimit: 7,
      },
      border: { color: C.grid },
    },

    y: {
      position: 'left',
      grid:     { color: C.grid, lineWidth: 1 },
      ticks: {
        color:    C.tick,
        font:     { family: MONO, size: 10 },
        callback: v => v.toFixed(2),
      },
      border: { color: C.grid },
      title: {
        display: true,
        text:    'Gauge (m)',
        color:   C.axisLabel,
        font:    { family: MONO, size: 10 },
        padding: { bottom: 4 },
      },
    },
  },
},

plugins: [nowLinePlugin()],
```

};
}

// ── NOW vertical line plugin ──────────────────────────────────────────────
function nowLinePlugin() {
return {
id: ‘nowLine’,
afterDraw(chart) {
const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
const nowTs = chart.options.plugins.nowLine?.nowTs ?? Date.now();
const nowX  = x.getPixelForValue(nowTs);

```
  if (nowX < x.left || nowX > x.right) return;

  ctx.save();

  // Dashed vertical line
  ctx.beginPath();
  ctx.moveTo(nowX, top);
  ctx.lineTo(nowX, bottom);
  ctx.strokeStyle = C.nowLine;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // "NOW" label
  ctx.fillStyle    = 'rgba(255,255,255,0.32)';
  ctx.font         = `9px ${MONO}`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('NOW', nowX, top + 4);

  ctx.restore();
},
```

};
}

// ── X-axis range ──────────────────────────────────────────────────────────
function xMin(periodH) {
return new Date(Date.now() - periodH * 3600 * 1000);
}

function xMax(fore, nowPoint) {
// Show up to end of forecast, or at least 1h ahead
if (fore && fore.length > 0) return fore[fore.length - 1].x;
return new Date(Date.now() + 60 * 60 * 1000);
}

// ── Tooltip time ──────────────────────────────────────────────────────────
function fmtTooltipTime(date) {
return date.toLocaleString(‘en-IE’, {
weekday: ‘short’,
day:     ‘numeric’,
month:   ‘short’,
hour:    ‘2-digit’,
minute:  ‘2-digit’,
hour12:  false,
});
}

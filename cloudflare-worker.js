/**

- Cloudflare Worker — EPA CORS Proxy for Bangor River Level app
- 
- Proxies both the ZIP (CSV data) and PNG (overview chart) from EPA HydroNet,
- adding CORS headers so the browser can fetch them from GitHub Pages.
- 
- DEPLOY (free, ~2 minutes):
- 1. Go to https://workers.cloudflare.com
- 1. Create a new Worker
- 1. Paste this entire file
- 1. Click Save and Deploy
- 1. Copy your worker URL, e.g.  https://epa-proxy.your-name.workers.dev
- 1. In js/app.js, uncomment and edit the first CORS_PROXIES entry:
- ```
     url => `https://epa-proxy.your-name.workers.dev?target=${encodeURIComponent(url)}`,
  ```
- 
- The worker accepts:  GET /?target=<encoded-EPA-URL>
- Caches ZIP for 8 minutes, PNG for 5 minutes (EPA updates every 15 min).
  */

const ALLOWED_HOSTS = [‘epawebapp.epa.ie’];
const CACHE_TTL = { zip: 480, png: 300 };  // seconds

export default {
async fetch(request, env, ctx) {
// CORS preflight
if (request.method === ‘OPTIONS’) {
return new Response(null, { status: 204, headers: corsHeaders() });
}

```
const url    = new URL(request.url);
const target = url.searchParams.get('target');

if (!target) {
  return new Response('Missing ?target= parameter', { status: 400, headers: corsHeaders() });
}

let targetURL;
try {
  targetURL = new URL(decodeURIComponent(target));
} catch {
  return new Response('Invalid target URL', { status: 400, headers: corsHeaders() });
}

// Security: only allow EPA hostname
if (!ALLOWED_HOSTS.includes(targetURL.hostname)) {
  return new Response('Forbidden host', { status: 403, headers: corsHeaders() });
}

const isZip = targetURL.pathname.endsWith('.zip');
const isPng = targetURL.pathname.endsWith('.png');
const ttl   = isZip ? CACHE_TTL.zip : CACHE_TTL.png;

// Check Cloudflare cache
const cache    = caches.default;
const cacheKey = new Request(targetURL.toString());
let response   = await cache.match(cacheKey);

if (!response) {
  // Fetch from EPA with a browser-like User-Agent
  const upstream = await fetch(targetURL.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept':     '*/*',
      'Referer':    'https://epawebapp.epa.ie/',
    },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });

  if (!upstream.ok) {
    return new Response(
      `EPA upstream error: ${upstream.status} ${upstream.statusText}`,
      { status: 502, headers: corsHeaders() }
    );
  }

  const contentType = isZip ? 'application/zip'
                    : isPng ? 'image/png'
                    : 'application/octet-stream';

  response = new Response(upstream.body, {
    status:  200,
    headers: {
      'Content-Type':  contentType,
      'Cache-Control': `public, max-age=${ttl}`,
      ...corsHeaders(),
    },
  });

  // Store in cache asynchronously
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
}

return new Response(response.body, {
  status:  response.status,
  headers: { ...Object.fromEntries(response.headers), ...corsHeaders() },
});
```

},
};

function corsHeaders() {
return {
‘Access-Control-Allow-Origin’:  ‘*’,
‘Access-Control-Allow-Methods’: ‘GET, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type’,
};
}

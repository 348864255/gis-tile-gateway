// ============================================================
// GIS Tile Gateway v1.0 — Main Tile Worker
// Deploy to: Cloudflare Workers
// Routes: hk-map.YOUR_DOMAIN/*, jp-map.YOUR_DOMAIN/*, sg-map.YOUR_DOMAIN/*
// Bindings: TILE_CACHE (KV, optional), TILE_R2 (R2 Bucket, optional)
//
// HOW TO USE:
//   1. Replace YOUR_DOMAIN and YOUR_TOKEN below
//   2. Deploy to Cloudflare Workers
//   3. Add routes (hk-map/jp-map/sg-map)
//   4. Done!
// ============================================================
// This script is the MAIN tile worker that actually fetches tiles
// from upstream providers (Google, Esri, Bing, etc.)
// ============================================================

// ============================================================
// 👇 CONFIGURE THESE VALUES BEFORE DEPLOYING 👇
// ============================================================

const CONFIG = {
  // Your custom access token (change to a random string)
  TOKEN: "YOUR_TOKEN",

  // Your domain (e.g., ycwx.kdns.fr)
  DOMAIN: "YOUR_DOMAIN",

  // Tianditu API Key (get yours at https://console.tianditu.gov.cn)
  TIANDITU_KEY: "YOUR_TIANDITU_KEY"
};

// ============================================================
// Provider priority by region (colo-based)
// ============================================================

const REGION_PROVIDERS = {
  asia: {
    colos: ["HKG", "NRT", "KIX", "SIN", "TPE", "ICN"],
    providers: ["GOOGLE", "ESRI", "BING"]
  },
  europe: {
    colos: ["LHR", "FRA", "AMS", "CDG", "MAD", "WAW", "ARN", "MXP"],
    providers: ["ESRI", "BING", "GOOGLE"]
  },
  america: {
    colos: ["IAD", "LAX", "ORD", "ATL", "MIA", "SEA", "SFO", "DFW", "JFK", "EWR", "BOS", "PHX", "DEN"],
    providers: ["ESRI", "GOOGLE", "BING"]
  },
  oceania: {
    colos: ["SYD", "MEL", "BNE", "AKL", "PER"],
    providers: ["BING", "ESRI", "GOOGLE"]
  },
  default: {
    colos: [],
    providers: ["GOOGLE", "ESRI", "BING"]
  }
};

// ============================================================
// Provider definitions
// ============================================================

const PROVIDERS = [
  {
    name: "GOOGLE",
    referer: "https://www.google.com/maps",
    url: (x, y, z) => `https://mt${Math.floor(Math.random() * 4)}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}&scale=1`
  },
  {
    name: "ESRI",
    referer: "https://www.arcgis.com",
    url: (x, y, z) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
  },
  {
    name: "BING",
    referer: "https://www.bing.com/maps",
    url: (x, y, z) => `https://ecn.t3.tiles.virtualearth.net/tiles/a${getQuadKey(x, y, z)}.jpeg?g=587`
  }
];

// ============================================================
// Main handler
// ============================================================

export default {

  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const path = url.pathname;

    // ==================== Token check ====================

    if (url.searchParams.get("token") !== CONFIG.TOKEN) {
      return new Response(
        "❌ Access Denied: Invalid Token.",
        { status: 403, headers: { "Content-Type": "text/html;charset=utf-8" } }
      );
    }

    // ==================== Node info ====================

    if (path === "/node-info") {
      return Response.json({
        colo:    request.cf?.colo    || "unknown",
        city:    request.cf?.city    || "unknown",
        country: request.cf?.country || "unknown",
        host:    url.hostname,
        time:    new Date().toISOString()
      });
    }

    // ==================== Health check ====================

    if (path === "/health") {
      return Response.json({
        status:  "ok",
        service: "GIS Tile Gateway v1.0",
        version: "1.0.0",
        colo:    request.cf?.colo || "unknown",
        host:    url.hostname,
        time:    new Date().toISOString()
      });
    }

    // ==================== Provider speed test ====================

    if (path === "/provider-speed") {
      return await measureProviderSpeed(request);
    }

    // ==================== Region info ====================

    if (path === "/region-info") {
      const colo = request.cf?.colo || "UNKNOWN";
      const region = getRegion(colo);
      return Response.json({ colo, region: region.name, providers: region.providers, host: url.hostname });
    }

    // ==================== Tile parameters ====================

    const x = Number(url.searchParams.get("x"));
    const y = Number(url.searchParams.get("y"));
    const z = Number(url.searchParams.get("z"));

    if (path !== "/" && path !== "/favicon.ico" && (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z))) {
      return new Response("Missing tile parameters", { status: 400 });
    }

    // ==================== Cache key ====================

    const cacheKeyString = `${path}?${url.searchParams.toString()}`;
    const cacheUrl = `https://cache.${url.hostname}${cacheKeyString}`;

    // ==================== 1. Memory cache (5 min) ====================

    const memCache = getMemoryCache();
    const mem = memCache.get(cacheKeyString);
    if (mem && Date.now() - mem.time < 300000) {
      if (env.TILE_CACHE) recordAccess(env, cacheKeyString);
      if (z >= 10) triggerPrefetch(path, x, y, z, cacheKeyString, cacheUrl, env, ctx);
      return new Response(mem.data, { headers: { ...mem.headers, "X-Cache": "MEM" } });
    }

    // ==================== 2. Edge Cache ====================

    let response = await caches.default.match(cacheUrl);
    if (response) {
      response = new Response(response.body, response);
      response.headers.set("X-Cache", "EDGE");
      if (env.TILE_CACHE) recordAccess(env, cacheKeyString);
      if (z >= 10) triggerPrefetch(path, x, y, z, cacheKeyString, cacheUrl, env, ctx);
      return response;
    }

    // ==================== 3. KV persistent cache ====================

    if (env.TILE_CACHE) {
      try {
        const kv = await env.TILE_CACHE.get(cacheKeyString, { type: "arrayBuffer" });
        if (kv) {
          response = new Response(kv, { headers: { "Content-Type": "image/jpeg", "X-Cache": "KV" } });
          await caches.default.put(cacheUrl, response.clone());
          if (z >= 10) triggerPrefetch(path, x, y, z, cacheKeyString, cacheUrl, env, ctx);
          return response;
        }
      } catch (e) { console.log("KV read failed:", e); }
    }

    // ==================== 4. R2 permanent storage ====================

    if (env.TILE_R2) {
      try {
        const r2Obj = await env.TILE_R2.get(cacheKeyString);
        if (r2Obj) {
          response = new Response(r2Obj.body, { headers: { "Content-Type": r2Obj.httpMetadata?.contentType || "image/jpeg", "X-Cache": "R2" } });
          const data = await r2Obj.arrayBuffer();
          await Promise.allSettled([
            env.TILE_CACHE?.put(cacheKeyString, data, { expirationTtl: 7776000 }),
            caches.default.put(cacheUrl, new Response(data, { headers: { "Cache-Control": "public, max-age=2592000" } }))
          ]);
          if (z >= 10) triggerPrefetch(path, x, y, z, cacheKeyString, cacheUrl, env, ctx);
          return response;
        }
      } catch (e) { console.log("R2 read failed:", e); }
    }

    // ==================== Request headers ====================

    const reqHeaders = new Headers();
    reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36");
    reqHeaders.set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
    reqHeaders.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");

    let target = "";
    let ttl = 2592000;
    let providerName = "";

    // =================================================
    // Auto-satellite: smart fallback between providers
    // =================================================

    if (path.startsWith("/auto-satellite")) {
      return await autoSatellite(x, y, z, reqHeaders, cacheKeyString, cacheUrl, env, request, ctx);
    }

    // =================================================
    // Google series
    // =================================================

    if (path.startsWith("/google")) {
      reqHeaders.set("Referer", "https://www.google.com/maps");
      const lyrs  = url.searchParams.get("lyrs") || "s";
      const scale = url.searchParams.get("scale") || "1";
      const sub   = Math.floor(Math.random() * 4);
      target = `https://mt${sub}.google.com/vt/lyrs=${lyrs}&x=${x}&y=${y}&z=${z}&scale=${scale}`;
      providerName = "Google";
    }

    // =================================================
    // Google History
    // =================================================

    else if (path.startsWith("/google-history")) {
      reqHeaders.set("Referer", "https://www.google.com/maps");
      const text = url.searchParams.get("text") || "0";
      target = text === "1"
        ? `https://mt1.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}`
        : `https://khm1.google.com/kh/v=952&x=${x}&y=${y}&z=${z}`;
      ttl = 7776000;
      providerName = "GoogleHistory";
    }

    // =================================================
    // Mapy.cz
    // =================================================

    else if (path.startsWith("/mapy")) {
      target = `https://mapserver.mapy.cz/base-en/${z}-${x}-${y}`;
      providerName = "Mapy";
    }

    // =================================================
    // Esri Satellite
    // =================================================

    else if (path.startsWith("/esri")) {
      target = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      providerName = "Esri";
    }

    // =================================================
    // Bing Satellite
    // =================================================

    else if (path.startsWith("/bing")) {
      target = `https://ecn.t3.tiles.virtualearth.net/tiles/a${getQuadKey(x, y, z)}.jpeg?g=587`;
      providerName = "Bing";
    }

    // =================================================
    // NASA MODIS True Color
    // =================================================

    else if (path.startsWith("/nasa")) {
      target = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/default/250m/${z}/${y}/${x}.jpg`;
      ttl = 86400;
      providerName = "NASA";
    }

    // =================================================
    // Tianditu (Chinese map, CGCS2000 ≈ WGS-84)
    // =================================================

    else if (path.startsWith("/tianditu")) {
      const type = url.searchParams.get("type") || "img";
      const subMap = { img: "t3", vec: "t6", cva: "t2" };
      const layerMap = { img: "img", vec: "vec", cva: "cva" };
      const sub = subMap[type] || "t3";
      const layer = layerMap[type] || "img";
      target =
        `https://${sub}.tianditu.gov.cn/${layer}_w/wmts?` +
        `SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&` +
        `LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&` +
        `TILECOL=${x}&TILEROW=${y}&TILEMATRIX=${z}&` +
        `tk=${CONFIG.TIANDITU_KEY}`;
      reqHeaders.set("Referer", "https://www.tianditu.gov.cn");
      providerName = "Tianditu";
    }

    // =================================================
    // Unknown path
    // =================================================

    else {
      return new Response(
        "🚀 GIS Tile Gateway v1.0\n" +
        `Node: ${request.cf?.colo || "unknown"} | ${url.hostname}\n` +
        "---\n" +
        "Available tile paths:\n" +
        "  /auto-satellite  — Auto-select fastest satellite\n" +
        "  /google          — Google (satellite/hybrid/vector/terrain)\n" +
        "  /google-history  — Google historical imagery\n" +
        "  /tianditu        — Tianditu (img/vec/cva)\n" +
        "  /esri            — Esri satellite\n" +
        "  /bing            — Bing satellite\n" +
        "  /nasa            — NASA MODIS\n" +
        "  /mapy            — Mapy.cz\n" +
        "---\n" +
        "Management:\n" +
        "  /node-info       — Current node info\n" +
        "  /health          — Health check\n" +
        "  /region-info     — Region and provider priority\n" +
        "  /provider-speed  — Provider speed test",
        { status: 200 }
      );
    }

    // ==================== Fetch upstream ====================

    try {
      response = await fetch(target, { headers: reqHeaders, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      return new Response(`Upstream fetch failed: ${e.message}`, { status: 502 });
    }

    if (providerName && response?.ok) {
      response = new Response(response.body, response);
      response.headers.set("X-Provider", providerName);
    }

    const result = await saveCache(response, cacheKeyString, cacheUrl, ttl, env);

    if (z >= 10) {
      triggerPrefetch(path, x, y, z, cacheKeyString, cacheUrl, env, ctx);
    }

    return result;
  }
};

// ============================================================
// Region detection
// ============================================================

function getRegion(colo) {
  for (const [key, region] of Object.entries(REGION_PROVIDERS)) {
    if (region.colos.includes(colo)) return { name: key, ...region };
  }
  return { name: "default", ...REGION_PROVIDERS.default };
}

// ============================================================
// Memory cache
// ============================================================

function getMemoryCache() {
  if (!globalThis.__tileCache) globalThis.__tileCache = new Map();
  return globalThis.__tileCache;
}

// ============================================================
// Auto-satellite: try Google → Esri → Bing, use first success
// ============================================================

async function autoSatellite(x, y, z, headers, cacheKeyString, cacheUrl, env, request, ctx) {
  const providers = [
    { name: "GOOGLE", referer: "https://www.google.com/maps", url: `https://mt${Math.floor(Math.random() * 4)}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}&scale=1` },
    { name: "ESRI",   referer: "https://www.arcgis.com",       url: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
    { name: "BING",   referer: "https://www.bing.com/maps",    url: `https://ecn.t3.tiles.virtualearth.net/tiles/a${getQuadKey(x, y, z)}.jpeg?g=587` }
  ];

  for (const p of providers) {
    try {
      const h = new Headers(headers);
      h.set("Referer", p.referer);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(p.url, { headers: h, signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        response = new Response(response.body, response);
        response.headers.set("X-Provider", p.name);
        const result = await saveCache(response, cacheKeyString, cacheUrl, 2592000, env);
        if (z >= 10) triggerPrefetch("/auto-satellite", x, y, z, cacheKeyString, cacheUrl, env, ctx);
        return result;
      }
    } catch (e) { console.log(p.name, "failed:", e.message); }
  }
  return new Response("Satellite providers unavailable", { status: 503 });
}

// ============================================================
// Provider speed test
// ============================================================

async function measureProviderSpeed(request) {
  const colo = request.cf?.colo || "UNKNOWN";
  const results = [];
  for (const p of PROVIDERS) {
    try {
      const h = new Headers();
      h.set("User-Agent", "Mozilla/5.0 GIS-Gateway-v1.0");
      h.set("Referer", p.referer);
      const start = Date.now();
      const r = await fetch(p.url(257, 257, 9), { headers: h, signal: AbortSignal.timeout(5000) });
      results.push({ provider: p.name, status: r.status, latency: Date.now() - start, ok: r.ok });
    } catch (e) {
      results.push({ provider: p.name, status: 0, latency: 9999, ok: false, error: e.message });
    }
  }
  results.sort((a, b) => { if (a.ok !== b.ok) return a.ok ? -1 : 1; return a.latency - b.latency; });
  return Response.json({ colo, time: new Date().toISOString(), best: results.find(r => r.ok)?.provider || null, results });
}

// ============================================================
// Tile prefetch (background)
// ============================================================

function triggerPrefetch(path, x, y, z, cacheKeyString, cacheUrl, env, ctx) {
  const prefetchTiles = [];
  for (let dx = 1; dx <= 3; dx++) {
    for (let dy = 1; dy <= 3; dy++) {
      const px = x + dx, py = y + dy;
      const maxTile = 1 << z;
      if (px < 0 || px >= maxTile || py < 0 || py >= maxTile) continue;
      const prefetchKey = `${path}?x=${px}&y=${py}&z=${z}`;
      const prefetchUrl = `https://cache.${cacheUrl.split("/")[2]}${prefetchKey}`;
      prefetchTiles.push({ key: prefetchKey, url: prefetchUrl, x: px, y: py, z });
    }
  }
  ctx.waitUntil(prefetchJob(prefetchTiles, env));
}

async function prefetchJob(tiles, env) {
  for (const tile of tiles) {
    try {
      const memCache = getMemoryCache();
      if (memCache.has(tile.key)) continue;
      if (await caches.default.match(tile.url)) continue;
      if (env.TILE_CACHE) {
        const kv = await env.TILE_CACHE.get(tile.key, { type: "arrayBuffer" });
        if (kv) {
          await caches.default.put(tile.url, new Response(kv, { headers: { "Cache-Control": "public, max-age=2592000" } }));
          continue;
        }
      }
    } catch (e) { console.log("Prefetch failed:", tile.key, e.message); }
  }
}

// ============================================================
// Tile access tracking (for R2 hot/cold tiering)
// ============================================================

async function recordAccess(env, cacheKey) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const today = new Date().toISOString().slice(0, 10);
    const statKey = `access:${cacheKey}`;
    const existing = await env.TILE_CACHE.get(statKey, { type: "json" });
    const stats = existing || { count: 0, firstAccess: now, lastAccess: now, dates: {} };
    stats.count += 1;
    stats.lastAccess = now;
    stats.dates[today] = (stats.dates[today] || 0) + 1;
    await env.TILE_CACHE.put(statKey, JSON.stringify(stats), { expirationTtl: 31536000 });
  } catch (e) { console.log("Access record failed:", e.message); }
}

// ============================================================
// Save cache (Memory + Edge + KV + R2)
// ============================================================

async function saveCache(response, cacheKeyString, cacheUrl, ttl, env) {
  if (!response || !response.ok) return response;
  try {
    const clone = response.clone();
    const data = await clone.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "image/jpeg";
    const headers = { "Content-Type": contentType, "X-Cache": "MISS" };

    // Memory cache
    const memCache = getMemoryCache();
    memCache.set(cacheKeyString, { data, headers, time: Date.now() });

    // Memory limit 100MB
    let totalSize = 0;
    for (const [, v] of memCache) totalSize += v.data?.byteLength || 0;
    if (totalSize > 100 * 1024 * 1024) {
      const oldestKey = memCache.keys().next().value;
      if (oldestKey) memCache.delete(oldestKey);
    }

    // Edge Cache
    await caches.default.put(cacheUrl, new Response(data, {
      headers: { "Content-Type": contentType, "Cache-Control": `public, max-age=${ttl}` }
    }));

    // KV persistent cache
    if (env.TILE_CACHE) {
      try { await env.TILE_CACHE.put(cacheKeyString, data, { expirationTtl: ttl }); }
      catch (e) { console.log("KV save failed:", e.message); }
    }

    // R2 permanent storage
    if (env.TILE_R2) {
      try {
        await env.TILE_R2.put(cacheKeyString, data, {
          httpMetadata: { contentType },
          customMetadata: { tier: "HOT", created: new Date().toISOString().slice(0, 10), accessed: new Date().toISOString().slice(0, 10) }
        });
      } catch (e) { console.log("R2 save failed:", e.message); }
    }

    return new Response(data, { headers });
  } catch (e) { console.log("Cache save failed:", e.message); return response; }
}

// ============================================================
// Bing QuadKey helper
// ============================================================

function getQuadKey(x, y, z) {
  let quadKey = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadKey += digit;
  }
  return quadKey;
}
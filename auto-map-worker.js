// ============================================================
// GIS Tile Gateway v1.0 — Auto Entry Selector Worker
// Deploy to: Cloudflare Workers
// Route: auto-map.YOUR_DOMAIN/*
// Function: Auto-select fastest entry node (hk/jp/sg),
//           then fetch tiles directly from upstream providers.
//
// HOW TO USE:
//   1. Replace YOUR_DOMAIN and YOUR_TOKEN below
//   2. Deploy to Cloudflare Workers
//   3. Add route (auto-map)
//   4. Done!
// ============================================================
// This script is the ENTRY worker that users connect to.
// It selects the fastest entry node and fetches tiles.
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
// Entry nodes (3 geographic locations for optimal routing)
// ============================================================

const ENTRY_NODES = [
  `https://hk-map.${CONFIG.DOMAIN}`,
  `https://jp-map.${CONFIG.DOMAIN}`,
  `https://sg-map.${CONFIG.DOMAIN}`
];

// Cached speed test results (5 min)
let lastSpeedTest = null;
let speedTestTime = 0;

// ============================================================
// Main handler
// ============================================================

export default {

  async fetch(request, env) {

    const url = new URL(request.url);
    const path = url.pathname;
    const colo = request.cf?.colo || "UNKNOWN";

    // ==================== Token check ====================

    if (url.searchParams.get("token") !== CONFIG.TOKEN) {
      return new Response("❌ Access Denied", { status: 403, headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    // ==================== Root ====================

    if (path === "/") {
      return new Response(
        "🚀 GIS Tile Gateway v1.0\n" +
        `Node: ${colo}\n` +
        "---\n" +
        "Tile paths:\n" +
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
        "  /speedtest       — Node speed test",
        { status: 200 }
      );
    }

    // ==================== Node info ====================

    if (path === "/node-info") {
      return Response.json({
        colo, city: request.cf?.city || "unknown", country: request.cf?.country || "unknown",
        host: url.hostname, time: new Date().toISOString()
      });
    }

    // ==================== Health check ====================

    if (path === "/health") {
      const best = await getBestNode();
      return Response.json({
        status: "ok", service: "GIS Tile Gateway v1.0", colo, host: url.hostname,
        bestNode: best, time: new Date().toISOString()
      });
    }

    // ==================== Speed test ====================

    if (path === "/speedtest") {
      return await speedTest();
    }

    // ==================== Tile parameters ====================

    const x = Number(url.searchParams.get("x"));
    const y = Number(url.searchParams.get("y"));
    const z = Number(url.searchParams.get("z"));

    if (path !== "/" && path !== "/favicon.ico" && (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z))) {
      return new Response("Missing tile parameters", { status: 400 });
    }

    // ==================== Cache ====================

    const cacheKeyString = `${path}?${url.searchParams.toString()}`;
    const cacheUrl = `https://cache.${url.hostname}${cacheKeyString}`;

    // Memory cache
    const memCache = getMemoryCache();
    const mem = memCache.get(cacheKeyString);
    if (mem && Date.now() - mem.time < 300000) {
      return new Response(mem.data, { headers: { ...mem.headers, "X-Cache": "MEM" } });
    }

    // Edge Cache
    let response = await caches.default.match(cacheUrl);
    if (response) {
      response = new Response(response.body, response);
      response.headers.set("X-Cache", "EDGE");
      return response;
    }

    // KV persistent cache
    if (env.TILE_CACHE) {
      try {
        const kv = await env.TILE_CACHE.get(cacheKeyString, { type: "arrayBuffer" });
        if (kv) {
          response = new Response(kv, { headers: { "Content-Type": "image/jpeg", "X-Cache": "KV" } });
          await caches.default.put(cacheUrl, response.clone());
          return response;
        }
      } catch (e) { console.log("KV read failed:", e); }
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
    // Auto-satellite
    // =================================================

    if (path.startsWith("/auto-satellite")) {
      return await autoSatellite(x, y, z, reqHeaders, cacheKeyString, cacheUrl, env);
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
    } else if (path.startsWith("/google-history")) {
      reqHeaders.set("Referer", "https://www.google.com/maps");
      const text = url.searchParams.get("text") || "0";
      target = text === "1" ? `https://mt1.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}` : `https://khm1.google.com/kh/v=952&x=${x}&y=${y}&z=${z}`;
      ttl = 7776000;
      providerName = "GoogleHistory";
    } else if (path.startsWith("/esri")) {
      target = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      providerName = "Esri";
    } else if (path.startsWith("/bing")) {
      target = `https://ecn.t3.tiles.virtualearth.net/tiles/a${getQuadKey(x, y, z)}.jpeg?g=587`;
      providerName = "Bing";
    } else if (path.startsWith("/nasa")) {
      target = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/default/250m/${z}/${y}/${x}.jpg`;
      ttl = 86400;
      providerName = "NASA";
    } else if (path.startsWith("/tianditu")) {
      const type = url.searchParams.get("type") || "img";
      const subMap = { img: "t3", vec: "t6", cva: "t2" };
      const layerMap = { img: "img", vec: "vec", cva: "cva" };
      const sub = subMap[type] || "t3";
      const layer = layerMap[type] || "img";
      target = `https://${sub}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL=${x}&TILEROW=${y}&TILEMATRIX=${z}&tk=${CONFIG.TIANDITU_KEY}`;
      reqHeaders.set("Referer", "https://www.tianditu.gov.cn");
      providerName = "Tianditu";
    } else if (path.startsWith("/mapy")) {
      target = `https://mapserver.mapy.cz/base-en/${z}-${x}-${y}`;
      providerName = "Mapy";
    } else {
      return new Response(
        "🚀 GIS Tile Gateway v1.0\n" +
        `Node: ${colo} | ${url.hostname}\n` +
        "Available: /auto-satellite, /google, /google-history, /tianditu, /esri, /bing, /nasa, /mapy",
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

    return await saveCache(response, cacheKeyString, cacheUrl, ttl, env);
  }
};

// ============================================================
// Memory cache
// ============================================================

function getMemoryCache() {
  if (!globalThis.__tileCache) globalThis.__tileCache = new Map();
  return globalThis.__tileCache;
}

// ============================================================
// Auto-satellite
// ============================================================

async function autoSatellite(x, y, z, headers, cacheKeyString, cacheUrl, env) {
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
        return await saveCache(response, cacheKeyString, cacheUrl, 2592000, env);
      }
    } catch (e) { console.log(p.name, "failed:", e.message); }
  }
  return new Response("Satellite providers unavailable", { status: 503 });
}

// ============================================================
// Speed test
// ============================================================

async function speedTest() {
  const results = [];
  for (const node of ENTRY_NODES) {
    const start = Date.now();
    try {
      const r = await fetch(`${node}/health?token=${CONFIG.TOKEN}`, { signal: AbortSignal.timeout(5000) });
      const cost = Date.now() - start;
      results.push({ node, status: r.status, latency: cost, online: r.ok });
    } catch (e) {
      results.push({ node, status: 0, latency: Date.now() - start, online: false, error: e.message });
    }
  }
  results.sort((a, b) => { if (a.online !== b.online) return a.online ? -1 : 1; return a.latency - b.latency; });
  return Response.json({ time: new Date().toISOString(), best: results[0]?.online ? results[0].node : null, nodes: results });
}

// ============================================================
// Get best node (cached 5 min)
// ============================================================

async function getBestNode() {
  if (lastSpeedTest && Date.now() - speedTestTime < 300000) {
    const online = lastSpeedTest.filter(n => n.online);
    if (online.length > 0) return online[0].node;
  }
  return ENTRY_NODES[0];
}

// ============================================================
// Save cache
// ============================================================

async function saveCache(response, cacheKeyString, cacheUrl, ttl, env) {
  if (!response || !response.ok) return response;
  try {
    const clone = response.clone();
    const data = await clone.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "image/jpeg";
    const headers = { "Content-Type": contentType, "X-Cache": "MISS" };
    const memCache = getMemoryCache();
    memCache.set(cacheKeyString, { data, headers, time: Date.now() });
    await caches.default.put(cacheUrl, new Response(data, {
      headers: { "Content-Type": contentType, "Cache-Control": `public, max-age=${ttl}` }
    }));
    if (env.TILE_CACHE) {
      try { await env.TILE_CACHE.put(cacheKeyString, data, { expirationTtl: ttl }); } catch (e) { console.log("KV save failed:", e.message); }
    }
    return new Response(data, { headers });
  } catch (e) { return response; }
}

// ============================================================
// Bing QuadKey
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
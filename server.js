import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "1.0.0";
const ADDON_ID = "dev.dex.audio-bridge";
const NAME = "Dex Audio Bridge";
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 9000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 90);
const API_BASES = (process.env.MONOCHROME_API_BASES ||
  "https://tracks.monochrome.st,https://api.monochrome.tf")
  .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);

const cache = new Map();
const hits = new Map();

function json(res, status, data, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    ...extra
  });
  res.end(JSON.stringify(data));
}
function cached(key, ttl) {
  const item = cache.get(key);
  if (item && item.until > Date.now()) return item.value;
  cache.delete(key);
  return null;
}
function putCache(key, value, ttl) {
  cache.set(key, { value, until: Date.now() + ttl });
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}
function qualityValue(value) {
  const q = String(value || "lossless").toLowerCase();
  if (q.includes("low")) return "LOW";
  if (q.includes("high")) return "HIGH";
  return "LOSSLESS";
}
function limited(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= RATE_LIMIT) {
    const retry = Math.max(1, Math.ceil((60000 - (now - recent[0])) / 1000));
    json(res, 429, { error: "Rate limit reached. Please retry shortly." },
      { "retry-after": String(retry) });
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "DexAudioBridge/1.0 (+self-hosted BitChord addon)"
      }
    });
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
async function upstreamSearch(query, quality) {
  const key = `search:${quality}:${query.toLowerCase()}`;
  const old = cached(key, 180000);
  if (old) return old;

  let lastError;
  for (const base of API_BASES) {
    try {
      // Monochrome's public catalogue API exposes /search/tracks.
      const endpoint = new URL(`${base}/search/tracks`);
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("limit", "25");
      const payload = await fetchJson(endpoint);
      const rows = Array.isArray(payload) ? payload :
        (payload.tracks || payload.data?.tracks || payload.results || []);
      const tracks = rows.map((item, index) => {
        const id = String(item.id ?? item.trackId ?? item.tidalId ?? "");
        const title = item.title ?? item.name;
        if (!id || !title) return null;
        const artist = typeof item.artist === "string" ? item.artist :
          (item.artist?.name || item.artists?.map(a => a.name).filter(Boolean).join(", ") || "");
        const album = typeof item.album === "string" ? item.album : (item.album?.title || item.album?.name || "");
        const duration = Number(item.duration ?? item.durationSeconds ?? 0);
        const artwork = item.artworkURL || item.cover || item.album?.cover ||
          item.album?.image || item.image || "";
        return {
          id,
          title: String(title),
          artist: String(artist),
          album: String(album),
          duration: Number.isFinite(duration) ? duration : 0,
          ...(artwork ? { artworkURL: String(artwork) } : {}),
          format: quality === "LOW" || quality === "HIGH" ? "aac" : "flac",
          audioQuality: quality
        };
      }).filter(Boolean).slice(0, 25);
      putCache(key, tracks, 180000);
      return tracks;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No catalogue API responded");
}
async function resolveTrack(id, quality) {
  const key = `stream:${quality}:${id}`;
  const old = cached(key, 45000);
  if (old) return old;

  let lastError;
  for (const base of API_BASES) {
    try {
      const endpoint = new URL(`${base}/track/${encodeURIComponent(id)}`);
      endpoint.searchParams.set("quality", quality);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "DexAudioBridge/1.0" }
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      let result;
      if (contentType.includes("application/json")) {
        const body = await response.json();
        const url = body.url || body.streamUrl || body.audioUrl || body.data?.url;
        if (!url) throw new Error("Upstream response did not contain a playable URL");
        result = {
          url,
          format: body.format || "flac",
          quality: body.quality || quality,
          codec: body.codec || (quality === "LOW" || quality === "HIGH" ? "aac" : "flac"),
          container: body.container || (quality === "LOW" || quality === "HIGH" ? "mp4" : "flac"),
          manifest: body.manifest || "none",
          encrypted: Boolean(body.encrypted),
          ...(body.sampleRate ? { sampleRate: Number(body.sampleRate) } : {}),
          ...(body.bitDepth ? { bitDepth: Number(body.bitDepth) } : {}),
          ...(body.bitrate ? { bitrate: Number(body.bitrate) } : {})
        };
      } else {
        // A direct audio response is not exposed as a temporary proxy.
        // The API route itself is returned as the stream URL.
        result = {
          url: endpoint.toString(),
          format: "flac",
          quality: quality === "LOSSLESS" ? "Lossless" : quality,
          codec: "flac",
          container: "flac",
          manifest: "none",
          encrypted: false
        };
      }
      if (!/^https?:\/\//i.test(result.url)) throw new Error("Invalid upstream stream URL");
      putCache(key, result, 45000);
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Track could not be resolved");
}

const manifest = {
  id: ADDON_ID,
  name: NAME,
  version: VERSION,
  description: "Independent music search and stream bridge maintained by Dex.",
  author: "Dex",
  resources: ["search", "stream"],
  allowDownloads: 1,
  checkValidLossless: 0,
  settings: [
    {
      key: "quality",
      type: "select",
      default: "lossless",
      options: [
        { label: "Lossless", value: "lossless" },
        { label: "High", value: "high" },
        { label: "Low", value: "low" }
      ]
    },
    {
      key: "prefer",
      type: "select",
      default: "studio",
      options: [
        { label: "Studio masters first", value: "studio" },
        { label: "Live and bootlegs first", value: "live" }
      ]
    }
  ]
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    return res.end();
  }
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  if (url.pathname === "/" || url.pathname === "/manifest.json") return json(res, 200, manifest);
  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true, id: ADDON_ID, name: NAME, version: VERSION,
      providers: API_BASES.map(base => ({ base, configured: true }))
    });
  }
  if (limited(req, res)) return;

  if (url.pathname === "/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json(res, 200, { tracks: [] });
    if (q.length > 180) return json(res, 400, { error: "Search query is too long" });
    try {
      const quality = qualityValue(url.searchParams.get("quality"));
      const tracks = await upstreamSearch(q, quality);
      return json(res, 200, { tracks });
    } catch (error) {
      return json(res, 502, { tracks: [], error: "Music catalogue is temporarily unavailable", detail: error.message });
    }
  }

  if (url.pathname.startsWith("/stream/")) {
    const id = decodeURIComponent(url.pathname.slice("/stream/".length));
    if (!id || id.length > 180) return json(res, 400, { error: "Invalid track id" });
    try {
      const quality = qualityValue(url.searchParams.get("quality"));
      return json(res, 200, await resolveTrack(id, quality));
    } catch (error) {
      return json(res, 404, { error: "No playable stream found", detail: error.message });
    }
  }
  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`${NAME} v${VERSION} listening on http://${HOST}:${PORT}`);
});

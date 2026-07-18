import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 8080);
const NUM_ENVS = Number(process.env.NUM_ENVS ?? 10);
const STATUS_BASE = Number(process.env.STATUS_BASE_PORT ?? 8865);
const VIEWER_BASE = Number(process.env.VIEWER_BASE_PORT ?? 3000);
const WS_BASE = Number(process.env.WS_BASE_PORT ?? 8765);
const SHARED_SERVER = process.env.SHARED_SERVER === "1" || process.env.SHARED_SERVER === "true";
const MC_PORT = Number(process.env.MC_PORT ?? 25565);
/** Optional override, e.g. 192.168.1.50 — otherwise uses the Host header from the browser. */
const PUBLIC_HOST = process.env.DASHBOARD_PUBLIC_HOST || "";

function mcPortFor(rank) {
  return SHARED_SERVER ? MC_PORT : MC_PORT + rank;
}

function clientHostname(req) {
  if (PUBLIC_HOST) return PUBLIC_HOST.replace(/^https?:\/\//, "").split(":")[0];
  const forwarded = req.headers["x-forwarded-host"];
  const host = String(forwarded || req.headers.host || "127.0.0.1")
    .split(",")[0]
    .trim();
  return host.split(":")[0] || "127.0.0.1";
}

/** Same-origin path so FRP of only :8080 reaches all bot views. */
function publicViewerUrl(_req, rank) {
  return `/viewer/${rank}/`;
}

function publicStatusUrl(req, rank) {
  const host = clientHostname(req);
  return `http://${host}:${STATUS_BASE + rank}/status`;
}

function viewerTarget(rank) {
  return `http://127.0.0.1:${VIEWER_BASE + rank}`;
}

/** Match /viewer/<rank> and optional rest path. */
function parseViewerPath(urlPath) {
  const match = /^\/viewer\/(\d+)(\/.*)?$/.exec(urlPath);
  if (!match) return null;
  const rank = Number(match[1]);
  if (!Number.isInteger(rank) || rank < 0 || rank >= NUM_ENVS) return null;
  return { rank, rest: match[2] || "/" };
}

function stripViewerPrefix(reqUrl) {
  const qIndex = reqUrl.indexOf("?");
  const pathOnly = qIndex >= 0 ? reqUrl.slice(0, qIndex) : reqUrl;
  const query = qIndex >= 0 ? reqUrl.slice(qIndex) : "";
  const parsed = parseViewerPath(pathOnly);
  if (!parsed) return null;
  return { ...parsed, rewriteUrl: parsed.rest + query };
}

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true
});

proxy.on("error", (error, _req, res) => {
  console.warn("Viewer proxy error:", error.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("viewer unavailable");
  } else if (res?.destroy) {
    res.destroy();
  }
});

const app = express();

// Proxy prismarine-viewer (HTTP) before static files
app.use((req, res, next) => {
  const parsed = stripViewerPrefix(req.url);
  if (!parsed) return next();
  req.url = parsed.rewriteUrl;
  proxy.web(req, res, { target: viewerTarget(parsed.rank) });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({
    numEnvs: NUM_ENVS,
    sharedServer: SHARED_SERVER,
    publicHost: clientHostname(req),
    bots: Array.from({ length: NUM_ENVS }, (_, i) => ({
      id: i,
      username: `rl_bot_${i}`,
      statusUrl: publicStatusUrl(req, i),
      viewerUrl: publicViewerUrl(req, i),
      wsPort: WS_BASE + i,
      mcPort: mcPortFor(i)
    }))
  });
});

app.get("/api/bots", async (req, res) => {
  const bots = await Promise.all(
    Array.from({ length: NUM_ENVS }, async (_, i) => {
      // Always fetch status locally on the training machine
      const localStatus = `http://127.0.0.1:${STATUS_BASE + i}/status`;
      const viewerUrl = publicViewerUrl(req, i);
      const statusUrl = publicStatusUrl(req, i);
      try {
        const response = await fetch(localStatus, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        return {
          id: i,
          online: true,
          ...status,
          statusUrl,
          viewerUrl
        };
      } catch (error) {
        return {
          id: i,
          online: false,
          username: `rl_bot_${i}`,
          statusUrl,
          viewerUrl,
          error: error.message,
          inventory: []
        };
      }
    })
  );
  res.json({ updatedAt: new Date().toISOString(), bots });
});

const server = http.createServer(app);

// Proxy prismarine-viewer WebSockets (socket.io under /viewer/<rank>/socket.io)
server.on("upgrade", (req, socket, head) => {
  const parsed = stripViewerPrefix(req.url || "");
  if (!parsed) {
    socket.destroy();
    return;
  }
  req.url = parsed.rewriteUrl;
  proxy.ws(req, socket, head, { target: viewerTarget(parsed.rank) });
});

server.listen(PORT, "0.0.0.0", () => {
  const mode = SHARED_SERVER ? `shared mc :${MC_PORT}` : "isolated servers";
  console.log(`Dashboard http://0.0.0.0:${PORT}  (${NUM_ENVS} bots, ${mode})`);
  console.log(`Views proxied at /viewer/<id>/  (backends :${VIEWER_BASE}-${VIEWER_BASE + NUM_ENVS - 1})`);
  console.log(`FRP tip: expose only :${PORT} for remote dashboard + all bot views`);
});

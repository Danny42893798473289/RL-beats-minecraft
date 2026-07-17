import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function publicViewerUrl(req, rank) {
  const host = clientHostname(req);
  return `http://${host}:${VIEWER_BASE + rank}/`;
}

function publicStatusUrl(req, rank) {
  const host = clientHostname(req);
  return `http://${host}:${STATUS_BASE + rank}/status`;
}

const app = express();
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
          // Force LAN-reachable URLs (bridge status embeds 127.0.0.1)
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
server.listen(PORT, "0.0.0.0", () => {
  const mode = SHARED_SERVER ? `shared mc :${MC_PORT}` : "isolated servers";
  console.log(`Dashboard http://0.0.0.0:${PORT}  (${NUM_ENVS} bots, ${mode})`);
  console.log(`LAN: open http://<this-machine-ip>:${PORT}  (views use ports ${VIEWER_BASE}-${VIEWER_BASE + NUM_ENVS - 1})`);
});

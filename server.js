import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
let runtimeConfig = {
  url: process.env.DT_ENVIRONMENT_URL || "",
  token: process.env.DT_API_TOKEN || "",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        configured: Boolean(resolveCreds(req).url && resolveCreds(req).token),
        envConfigured: Boolean(process.env.DT_ENVIRONMENT_URL && process.env.DT_API_TOKEN),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      runtimeConfig = {
        url: String(body.url || "").replace(/\/+$/, ""),
        token: String(body.token || ""),
      };
      return json(res, 200, { ok: true, configured: Boolean(runtimeConfig.url && runtimeConfig.token) });
    }

    if (req.method === "GET" && url.pathname === "/api/problems") {
      const creds = resolveCreds(req);
      if (!creds.url || !creds.token) {
        return json(res, 400, {
          error: "Dynatrace is not configured. Add DT_ENVIRONMENT_URL and DT_API_TOKEN to .env, or save them in Settings.",
        });
      }

      const from = url.searchParams.get("from") || "now-7d";
      const to = url.searchParams.get("to") || "now";
      const data = await fetchAllProblems(creds, from, to);
      return json(res, 200, data);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    const status = err.status || 500;
    json(res, status, { error: err.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Dynatrace SLA dashboard → http://localhost:${PORT}`);
});

function resolveCreds(req) {
  const headerUrl = String(req.headers["x-dt-url"] || "").replace(/\/+$/, "");
  const headerToken = String(req.headers["x-dt-token"] || "");
  return {
    url: headerUrl || runtimeConfig.url || "",
    token: headerToken || runtimeConfig.token || "",
  };
}

async function fetchAllProblems(creds, from, to) {
  const problems = [];
  let nextPageKey = null;
  let totalCount = 0;
  let warnings = [];

  do {
    const endpoint = new URL("/api/v2/problems", creds.url);
    endpoint.searchParams.set("from", from);
    endpoint.searchParams.set("to", to);
    endpoint.searchParams.set("pageSize", "500");
    if (nextPageKey) endpoint.searchParams.set("nextPageKey", nextPageKey);

    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Api-Token ${creds.token}`,
        Accept: "application/json",
      },
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      const error = new Error(`Dynatrace returned non-JSON (${response.status})`);
      error.status = response.status;
      throw error;
    }

    if (!response.ok) {
      const message = payload.error?.message || payload.message || `Dynatrace API ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    totalCount = payload.totalCount ?? totalCount;
    warnings = payload.warnings || warnings;
    problems.push(...(payload.problems || []));
    nextPageKey = payload.nextPageKey || null;
  } while (nextPageKey);

  return { totalCount, warnings, problems, from, to, fetchedAt: Date.now() };
}

function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

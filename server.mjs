import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT || 10000);

const backend = String(
  process.env.CREATION_BACKEND_URL || ""
).replace(/\/+$/, "");

const backendToken = String(
  process.env.CREATION_BACKEND_TOKEN || ""
);

const timeoutMs = Number(
  process.env.CREATION_PROXY_TIMEOUT_MS || 120000
);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });

  res.end(body);
}

async function readBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxy(req, res) {
  if (!backend) {
    json(res, 503, {
      error: "CREATION_BACKEND_URL is not configured"
    });
    return;
  }

  const target = backend + req.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (
        value !== undefined &&
        ![
          "host",
          "content-length",
          "connection",
          "user-agent",
          "accept-encoding"
        ].includes(
          key.toLowerCase()
        )
      ) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    headers.set("accept", "application/json");

    // zrok's free tier serves an HTML interstitial to anything that looks
    // like a browser. Forwarding Chrome's user-agent made every browser
    // request return that page instead of JSON.
    headers.set("user-agent", "CREATION-proxy/1.0");
    headers.set("skip_zrok_interstitial", "1");

    if (backendToken) {
      headers.set("authorization", `Bearer ${backendToken}`);
    }

    const method = req.method || "GET";

    const upstream = await fetch(target, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method)
        ? undefined
        : await readBody(req),
      signal: controller.signal,
      cache: "no-store"
    });

    const responseHeaders = {};

    upstream.headers.forEach((value, key) => {
      if (
        ![
          "connection",
          "content-encoding",
          "content-length",
          "keep-alive",
          "transfer-encoding"
        ].includes(key.toLowerCase())
      ) {
        responseHeaders[key] = value;
      }
    });

    responseHeaders["cache-control"] = "no-store";

    const body = Buffer.from(await upstream.arrayBuffer());

    responseHeaders["content-length"] = String(body.length);

    res.writeHead(upstream.status, responseHeaders);
    res.end(body);
  } catch (error) {
    json(res, 502, {
      error: "CREATION field backend is unreachable",
      detail:
        error?.name === "AbortError"
          ? "upstream request timed out"
          : String(error?.message || error)
    });
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname
    );
  } catch {
    json(res, 400, { error: "invalid request path" });
    return;
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  let relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  relative = relative.replace(/^[/\\]+/, "");

  let file = join(root, relative);

  try {
    const info = await stat(file);

    if (info.isDirectory()) {
      file = join(file, "index.html");
    }

    const body = await readFile(file);

    res.writeHead(200, {
      "content-type":
        mime[extname(file).toLowerCase()] ||
        "application/octet-stream",
      "content-length": body.length,
      "cache-control":
        extname(file) === ".html"
          ? "no-cache"
          : "public, max-age=3600"
    });

    res.end(body);
  } catch {
    const fallback = await readFile(join(root, "index.html"));

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": fallback.length,
      "cache-control": "no-cache"
    });

    res.end(fallback);
  }
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    json(res, 200, {
      ok: true,
      service: "creation",
      backendConfigured: Boolean(backend)
    });
    return;
  }

  if (req.url?.startsWith("/field/")) {
    await proxy(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`CREATION listening on 0.0.0.0:${port}`);
  console.log(
    backend
      ? `Field backend: ${backend}`
      : "Field backend is not configured"
  );
});

/**
 * HTTP surface (Architecture §1, §13).
 *
 * A thin, STATELESS adapter from node:http to the route handlers. It parses the
 * request, resolves the principal from the Authorization header, dispatches, and
 * writes a JSON response. It holds no state — every request is self-contained,
 * so this scales horizontally (Flex Functions in production). Using node:http
 * keeps it dependency-free and Bun-compatible (D-11).
 *
 * `dispatch` is exported separately so tests can exercise the full routing +
 * authorization + domain stack without opening a socket.
 */

import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize, extname, join } from "node:path";
import type { Platform } from "./platform.ts";
import { matchRoute } from "./router.ts";
import { routes, type ApiRequest, type ApiResponse } from "./routes.ts";
import { resolvePrincipal } from "./authz.ts";

export interface RawRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string | undefined;
  readonly body: unknown;
}

/** Pure dispatch: raw request → response. No sockets. */
export async function dispatch(platform: Platform, raw: RawRequest): Promise<ApiResponse> {
  const url = new URL(raw.url, "http://internal");
  const matched = matchRoute(routes, raw.method, url.pathname);
  if (!matched) return { status: 404, body: { error: "no such route" } };
  const principal = await resolvePrincipal(platform, raw.authorization);
  const req: ApiRequest = {
    params: matched.match.params,
    query: url.searchParams,
    body: raw.body,
    principal,
  };
  try {
    return await matched.route.handler(platform, req);
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// The SPA lives in <project>/public; this file is <project>/src/api/server.ts.
const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Serve a static file from PUBLIC_DIR; returns true if handled. */
function serveStatic(urlPath: string, res: ServerResponse): boolean {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden"); // path traversal guard
    return true;
  }
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const type = CONTENT_TYPES[extname(full)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(full));
  return true;
}

export function createServer(platform: Platform): Server {
  return httpCreateServer((httpReq: IncomingMessage, httpRes: ServerResponse) => {
    const method = httpReq.method ?? "GET";
    const path = (httpReq.url ?? "/").split("?")[0] ?? "/";
    // Non-API GETs are served from the SPA; unknown paths fall back to the app
    // shell so client-side navigation works.
    if (method === "GET" && !path.startsWith("/api/")) {
      if (serveStatic(path, httpRes)) return;
      if (serveStatic("/index.html", httpRes)) return;
      httpRes.writeHead(404).end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    httpReq.on("data", (c: Buffer) => chunks.push(c));
    httpReq.on("end", async () => {
      let body: unknown = undefined;
      if (chunks.length > 0) {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          writeJson(httpRes, { status: 400, body: { error: "invalid JSON body" } });
          return;
        }
      }
      const result = await dispatch(platform, {
        method: httpReq.method ?? "GET",
        url: httpReq.url ?? "/",
        authorization: httpReq.headers["authorization"],
        body,
      });
      writeJson(httpRes, result);
    });
  });
}

function writeJson(res: ServerResponse, result: ApiResponse): void {
  // BigInt-safe: internal keys are bigint; serialize them as numbers (case
  // keys are well within Number's safe range). Handlers already convert on the
  // hot paths — this is a defensive net so no bigint ever crashes a response.
  const payload = JSON.stringify(result.body, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(payload);
}

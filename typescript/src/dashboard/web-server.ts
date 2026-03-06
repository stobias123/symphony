import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { OrchestratorSnapshot } from "../orchestrator.js";
import type { SessionStore } from "../session-store.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function toApiPayload(snap: OrchestratorSnapshot) {
  return {
    running: snap.running.map((r) => ({
      issueId: r.issueId,
      identifier: r.identifier,
      state: r.state,
      title: r.title,
      startedAt: r.startedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      usage: {
        inputTokens: r.usage.inputTokens ?? 0,
        outputTokens: r.usage.outputTokens ?? 0,
        totalTokens: r.usage.totalTokens ?? 0,
      },
      turnNumber: r.turnNumber,
      lastEvent: r.lastEvent,
      stage: r.stage,
      messages: r.messages,
      estimatedCostUsd: r.estimatedCostUsd,
    })),
    retrying: snap.retrying.map((r) => ({
      issueId: r.issueId,
      identifier: r.identifier,
      attempt: r.attempt,
      dueAtMs: r.dueAtMs,
      error: r.error ?? null,
    })),
    codexTotals: {
      inputTokens: snap.codexTotals.inputTokens ?? 0,
      outputTokens: snap.codexTotals.outputTokens ?? 0,
      totalTokens: snap.codexTotals.totalTokens ?? 0,
    },
    cumulativeTotals: snap.cumulativeTotals,
    totalCostUsd: snap.totalCostUsd,
    polling: snap.polling,
    startedAt: snap.startedAt.toISOString(),
    provider: snap.provider,
  };
}

export class WebDashboardServer {
  private server: Server | null = null;
  private sseClients = new Set<ServerResponse>();
  private sseInterval: ReturnType<typeof setInterval> | null = null;
  private getSnapshot: () => OrchestratorSnapshot;
  private triggerRefresh?: () => void;
  private sessionStore?: SessionStore;
  private staticDir: string;
  private port: number;
  private host: string;

  private getContentMessages?: (identifier: string) => import("../providers/types.js").ContentMessage[] | null;

  constructor(opts: {
    getSnapshot: () => OrchestratorSnapshot;
    triggerRefresh?: () => void;
    sessionStore?: SessionStore;
    getContentMessages?: (identifier: string) => import("../providers/types.js").ContentMessage[] | null;
    port?: number;
    host?: string;
  }) {
    this.getSnapshot = opts.getSnapshot;
    this.triggerRefresh = opts.triggerRefresh;
    this.sessionStore = opts.sessionStore;
    this.getContentMessages = opts.getContentMessages;
    this.port = opts.port ?? 0;
    this.host = opts.host ?? "127.0.0.1";
    // When running from dist/, static/ is a sibling. When running via tsx from src/,
    // fall back to dist/dashboard/static/ (requires build:web to have run).
    const candidate = path.join(import.meta.dirname, "static");
    this.staticDir = existsSync(candidate)
      ? candidate
      : path.resolve(import.meta.dirname, "../../dist/dashboard/static");
  }

  async start(): Promise<{ port: number; host: string }> {
    const server = createServer((req, res) => this.handleRequest(req, res));
    this.server = server;

    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.host = addr.address;
        }
        this.startSSEBroadcast();
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  stop(): void {
    if (this.sseInterval) {
      clearInterval(this.sseInterval);
      this.sseInterval = null;
    }
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private startSSEBroadcast(): void {
    this.sseInterval = setInterval(() => {
      if (this.sseClients.size === 0) return;
      const data = JSON.stringify(toApiPayload(this.getSnapshot()));
      for (const client of this.sseClients) {
        client.write(`data: ${data}\n\n`);
      }
    }, 1000);
    this.sseInterval.unref();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url === "/api/v1/state" && method === "GET") {
      const payload = toApiPayload(this.getSnapshot());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (url === "/api/v1/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Send initial snapshot immediately
      const data = JSON.stringify(toApiPayload(this.getSnapshot()));
      res.write(`data: ${data}\n\n`);

      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (url === "/api/v1/refresh" && method === "POST") {
      if (this.triggerRefresh) {
        this.triggerRefresh();
      }
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted" }));
      return;
    }

    // Session messages for completed sessions: /api/v1/sessions/:id/messages
    const sessionMsgMatch = url.match(/^\/api\/v1\/sessions\/(\d+)\/messages$/);
    if (sessionMsgMatch && method === "GET") {
      if (this.sessionStore) {
        const sessionId = parseInt(sessionMsgMatch[1]!, 10);
        const messages = this.sessionStore.getSessionMessages(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: [] }));
      }
      return;
    }

    if (url.startsWith("/api/v1/sessions") && method === "GET") {
      if (this.sessionStore) {
        const params = new URL(url, "http://localhost").searchParams;
        const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "50", 10) || 50, 1), 200);
        const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);
        const sessions = this.sessionStore.getSessions({ limit, offset });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: [] }));
      }
      return;
    }

    // Content messages for running sessions: /api/v1/running/:identifier/messages
    const runningMsgMatch = url.match(/^\/api\/v1\/running\/([^/]+)\/messages$/);
    if (runningMsgMatch && method === "GET") {
      const identifier = decodeURIComponent(runningMsgMatch[1]!);
      const messages = this.getContentMessages?.(identifier) ?? null;
      if (messages) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }

    // Single issue detail: /api/v1/:identifier
    if (url.startsWith("/api/v1/") && method === "GET") {
      const identifier = decodeURIComponent(url.slice("/api/v1/".length));
      if (identifier && identifier !== "state" && identifier !== "events" && identifier !== "refresh") {
        const snap = this.getSnapshot();
        const entry = snap.running.find((r) => r.identifier === identifier)
          ?? snap.retrying.find((r) => r.identifier === identifier);
        if (entry) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(entry));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
        return;
      }
    }

    // Static file serving
    this.serveStatic(url, res);
  }

  private serveStatic(url: string, res: ServerResponse): void {
    let filePath: string;
    if (url === "/" || url === "/index.html") {
      filePath = path.join(this.staticDir, "index.html");
    } else {
      // Sanitize path to prevent directory traversal
      const cleaned = path.normalize(url).replace(/^(\.\.[/\\])+/, "");
      filePath = path.join(this.staticDir, cleaned);
    }

    // Ensure resolved path is within staticDir
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.staticDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (existsSync(resolved)) {
      const ext = path.extname(resolved);
      const contentType = MIME[ext] ?? "application/octet-stream";
      try {
        const content = readFileSync(resolved);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      } catch {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    } else {
      // SPA fallback — serve index.html for non-file routes
      const indexPath = path.join(this.staticDir, "index.html");
      if (existsSync(indexPath)) {
        try {
          const content = readFileSync(indexPath);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(content);
        } catch {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    }
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "../../logger.js";

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export class JsonRpcClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private pendingLine = "";
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  get osPid(): string | undefined {
    return this.process?.pid?.toString();
  }

  spawn(command: string, cwd: string): void {
    this.process = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString());
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        if (/\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(text)) {
          logger.warn({ source: "codex-stderr" }, text.slice(0, 1000));
        } else {
          logger.debug({ source: "codex-stderr" }, text.slice(0, 1000));
        }
      }
    });

    this.process.on("exit", (code) => {
      this.emit("exit", code);
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Process exited with code ${code}`));
        clearTimeout(pending.timer);
      }
      this.pendingRequests.clear();
    });
  }

  async send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC timeout waiting for response to ${method} (id=${id})`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeLine(message);
    });
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeLine({ method, params });
  }

  sendResult(id: number, result: unknown): void {
    this.writeLine({ id, result });
  }

  close(): void {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Already dead
      }
      this.process = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client closed"));
    }
    this.pendingRequests.clear();
  }

  private writeLine(message: JsonRpcMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("Process stdin not writable");
    }
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleData(data: string): void {
    this.pendingLine += data;
    const lines = this.pendingLine.split("\n");
    this.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as JsonRpcMessage;
        this.handleMessage(parsed);
      } catch {
        if (/\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(trimmed)) {
          logger.warn({ source: "codex-stdout" }, trimmed.slice(0, 1000));
        } else {
          logger.debug({ source: "codex-stdout" }, trimmed.slice(0, 1000));
        }
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    // Response to a pending request
    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Server-initiated request or notification
    this.emit("message", message);
  }
}

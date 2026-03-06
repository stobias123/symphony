import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";

export interface LoadedWorkflow {
  config: Record<string, unknown>;
  prompt: string;
  promptTemplate: string;
}

interface WorkflowStamp {
  mtime: number;
  size: number;
  hash: string;
}

export class Workflow {
  private filePath: string;
  private cached: LoadedWorkflow | null = null;
  private stamp: WorkflowStamp | null = null;
  private watchInterval: ReturnType<typeof setInterval> | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(process.cwd(), "WORKFLOW.md");
  }

  current(): LoadedWorkflow | null {
    if (!this.cached) {
      this.reload();
    }
    return this.cached;
  }

  reload(): void {
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const newStamp = this.computeStamp(content);

      if (this.stamp && this.stampsEqual(this.stamp, newStamp)) {
        return;
      }

      const loaded = parseWorkflow(content);
      this.cached = loaded;
      this.stamp = newStamp;
      logger.info({ path: this.filePath }, "Workflow loaded");
    } catch (err) {
      if (this.cached) {
        logger.warn({ err, path: this.filePath }, "Workflow reload failed, keeping previous");
      } else {
        logger.error({ err, path: this.filePath }, "Workflow load failed");
      }
    }
  }

  startWatching(intervalMs = 1000): void {
    this.stopWatching();
    this.watchInterval = setInterval(() => this.checkForChanges(), intervalMs);
    this.watchInterval.unref();
  }

  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }

  private checkForChanges(): void {
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const newStamp = this.computeStamp(content);

      if (!this.stamp || !this.stampsEqual(this.stamp, newStamp)) {
        const loaded = parseWorkflow(content);
        this.cached = loaded;
        this.stamp = newStamp;
        logger.info({ path: this.filePath }, "Workflow hot-reloaded");
      }
    } catch {
      // File might be temporarily unavailable during save
    }
  }

  private computeStamp(content: string): WorkflowStamp {
    return {
      mtime: this.getFileMtime(),
      size: Buffer.byteLength(content),
      hash: createHash("md5").update(content).digest("hex"),
    };
  }

  private getFileMtime(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private stampsEqual(a: WorkflowStamp, b: WorkflowStamp): boolean {
    return a.mtime === b.mtime && a.size === b.size && a.hash === b.hash;
  }
}

export function parseWorkflow(content: string): LoadedWorkflow {
  const { frontMatter, body } = splitFrontMatter(content);

  let config: Record<string, unknown> = {};
  if (frontMatter.trim()) {
    const parsed = yaml.load(frontMatter);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    } else if (parsed !== null && parsed !== undefined) {
      throw new Error("WORKFLOW.md front matter must be a YAML map");
    }
  }

  const prompt = body.trim();
  return { config, prompt, promptTemplate: prompt };
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontMatter: "", body: content };
  }

  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1) {
    return { frontMatter: lines.slice(1).join("\n"), body: "" };
  }

  return {
    frontMatter: lines.slice(1, endIndex).join("\n"),
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

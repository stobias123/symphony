import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { logger } from "./logger.js";
import type { Config } from "./config.js";
import type { Issue } from "./trackers/types.js";

export class Workspace {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async createForIssue(issue: Issue): Promise<string> {
    const safeId = safeIdentifier(issue.identifier);
    const workspace = path.join(this.config.workspaceRoot, safeId);

    validateWorkspacePath(workspace, this.config.workspaceRoot);
    const created = ensureWorkspace(workspace);

    if (created) {
      const hook = this.config.workspaceHooks.after_create;
      if (hook) {
        await this.runHook(hook, workspace, issue, "after_create");
      }
    }

    return workspace;
  }

  async remove(workspace: string): Promise<void> {
    if (!fs.existsSync(workspace)) return;
    validateWorkspacePath(workspace, this.config.workspaceRoot);

    const hook = this.config.workspaceHooks.before_remove;
    if (hook && fs.statSync(workspace).isDirectory()) {
      await this.runHook(hook, workspace, null, "before_remove").catch(() => {});
    }

    fs.rmSync(workspace, { recursive: true, force: true });
  }

  async removeIssueWorkspaces(identifier: string): Promise<void> {
    const safeId = safeIdentifier(identifier);
    const workspace = path.join(this.config.workspaceRoot, safeId);
    await this.remove(workspace);
  }

  async runBeforeRunHook(workspace: string, issue: Issue): Promise<void> {
    const hook = this.config.workspaceHooks.before_run;
    if (hook) {
      await this.runHook(hook, workspace, issue, "before_run");
    }
  }

  async runAfterRunHook(workspace: string, issue: Issue): Promise<void> {
    const hook = this.config.workspaceHooks.after_run;
    if (hook) {
      await this.runHook(hook, workspace, issue, "after_run").catch(() => {});
    }
  }

  private runHook(
    command: string,
    workspace: string,
    issue: Issue | null,
    hookName: string,
  ): Promise<void> {
    const timeoutMs = this.config.hookTimeoutMs;

    logger.info(
      {
        hook: hookName,
        issueId: issue?.id,
        identifier: issue?.identifier,
        workspace,
      },
      "Running workspace hook",
    );

    return new Promise((resolve, reject) => {
      const child = execFile(
        "sh",
        ["-lc", command],
        {
          cwd: workspace,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const output = (stdout + stderr).slice(0, 2048);
            logger.warn(
              {
                hook: hookName,
                identifier: issue?.identifier,
                workspace,
                exitCode: error.code,
                output,
              },
              "Workspace hook failed",
            );
            reject(new Error(`Hook ${hookName} failed: ${error.message}`));
            return;
          }
          resolve();
        },
      );
      child.unref?.();
    });
  }
}

function safeIdentifier(identifier: string | null | undefined): string {
  return (identifier ?? "issue").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureWorkspace(workspace: string): boolean {
  if (fs.existsSync(workspace)) {
    const stat = fs.statSync(workspace);
    if (stat.isDirectory()) {
      cleanTmpArtifacts(workspace);
      return false;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  fs.mkdirSync(workspace, { recursive: true });
  return true;
}

function cleanTmpArtifacts(workspace: string): void {
  for (const entry of [".elixir_ls", "tmp"]) {
    const p = path.join(workspace, entry);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
}

function validateWorkspacePath(workspace: string, root: string): void {
  const expandedWorkspace = path.resolve(workspace);
  const expandedRoot = path.resolve(root);

  if (expandedWorkspace === expandedRoot) {
    throw new Error(`Workspace path equals root: ${expandedWorkspace}`);
  }

  if (!expandedWorkspace.startsWith(expandedRoot + path.sep)) {
    throw new Error(
      `Workspace ${expandedWorkspace} is outside root ${expandedRoot}`,
    );
  }

  // Check for symlink escape
  const relative = path.relative(expandedRoot, expandedWorkspace);
  const segments = relative.split(path.sep);
  let current = expandedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink escape detected: ${current}`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }
}

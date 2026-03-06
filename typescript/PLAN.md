# Symphony TypeScript Reimplementation Plan

## Goal

Reimplement the Elixir Symphony orchestrator in TypeScript with a **model provider abstraction** that supports both OpenAI Codex (app-server JSON-RPC) and Claude Agent SDK as interchangeable backends.

## Architecture

```
src/
  index.ts                          # CLI entry point
  orchestrator.ts                   # Poll-dispatch-reconcile loop
  agent-runner.ts                   # Per-issue lifecycle (workspace -> hooks -> agent turns)
  config.ts                         # WORKFLOW.md YAML frontmatter -> validated config
  workflow.ts                       # WORKFLOW.md parsing + hot-reload
  workspace.ts                      # Isolated directory management + hooks
  prompt-builder.ts                 # Liquid template rendering

  providers/
    types.ts                        # AgentProvider interface
    codex/
      codex-provider.ts             # Codex app-server JSON-RPC over stdio
      json-rpc-client.ts            # Line-buffered JSON-RPC 2.0 stdio client
    claude/
      claude-provider.ts            # Claude Agent SDK provider

  trackers/
    types.ts                        # Tracker interface + Issue type
    linear/
      linear-adapter.ts             # Linear Tracker implementation
      linear-client.ts              # GraphQL client with pagination
    jira/
      jira-adapter.ts               # Jira Tracker implementation
      jira-client.ts                # REST client with pagination

  tools/
    dynamic-tool.ts                 # Server-side tool execution (linear_graphql, jira_rest, confluence_rest)
    tool-specs.ts                   # Tool JSON Schema definitions

  dashboard/
    status-reporter.ts              # Terminal status display
```

## Phase 1: Foundation

### 1.1 Project setup
- `package.json` with TypeScript, tsx, vitest
- `tsconfig.json` targeting ES2022/Node18+
- Dependencies: `zod` (config validation), `liquidjs` (templates), `js-yaml` (YAML), `pino` (logging)

### 1.2 Core types
- `Issue` interface (shared across trackers)
- `AgentProvider` interface
- `Tracker` interface
- Config schema with Zod

### 1.3 Workflow parser
- Parse WORKFLOW.md: YAML frontmatter + Markdown body
- Hot-reload via fs.watch or polling
- Zod validation of config structure

### 1.4 Config module
- Map validated YAML to typed config
- Env var resolution ($VAR, ~/ expansion)
- Default values matching Elixir implementation

## Phase 2: Tracker Adapters

### 2.1 Linear adapter
- GraphQL client with cursor-based pagination
- Assignee filtering ("me" -> viewer query)
- Issue normalization to shared Issue type
- Blocker extraction from inverse relations
- Comment creation + state update mutations

### 2.2 Jira adapter
- REST client with offset-based pagination
- JQL query builder
- ADF description text extraction
- ADF comment body construction
- Transition-based state updates
- Basic auth (email:token) or Bearer token

### 2.3 Memory adapter (for testing)

## Phase 3: Agent Providers

### 3.1 Provider interface
```typescript
interface AgentProvider {
  name: string;
  startSession(workspace: string): Promise<AgentSession>;
  runTurn(session: AgentSession, prompt: string, issue: Issue, opts?: TurnOptions): Promise<TurnResult>;
  stopSession(session: AgentSession): Promise<void>;
}
```

### 3.2 Codex provider
- Spawn child process with `codex app-server`
- Line-buffered JSON-RPC 2.0 over stdio
- Handle: initialize, thread/start, turn/start, turn/completed, turn/failed
- Auto-approve approval requests when policy is "never"
- Execute dynamic tool calls (linear_graphql, jira_rest, confluence_rest)
- Handle turn input-required, cancellation, timeouts

### 3.3 Claude Agent SDK provider
- Use @anthropic-ai/agent-sdk (or direct API)
- Map WORKFLOW.md tools to Claude tool definitions
- Execute agent loop with tool use handling
- Map completion states to TurnResult

## Phase 4: Orchestrator + Agent Runner

### 4.1 Agent Runner
- Create/reuse workspace
- Run lifecycle hooks (after_create, before_run, after_run)
- Multi-turn loop: run provider turn, check issue state, continue or stop
- Continuation prompts for subsequent turns

### 4.2 Orchestrator
- Polling loop with configurable interval
- Candidate filtering: active states, assignee, not terminal, not blocked
- Priority-based sorting (priority asc, created_at asc, identifier asc)
- Concurrency control: global max + per-state limits
- Retry with exponential backoff (continuation=1s, failure=10s*2^attempt)
- Reconciliation: re-check running issue states, stop agents for terminal issues
- Stall detection based on last activity timestamp
- Token accounting with monotonic watermarks

### 4.3 Workspace management
- Create isolated directories under workspace root
- Symlink escape prevention
- Hook execution with timeout
- Cleanup on terminal state

## Phase 5: Observability

### 5.1 Terminal status reporter
- Periodic snapshot rendering
- Running agents, retry queue, token totals
- Rate limit display
- Simplified version of Elixir's box-drawing dashboard

## Implementation Order

1. Types + Config + Workflow (no external deps needed to test)
2. Tracker adapters (can test against real Linear/Jira)
3. Codex provider (direct port of JSON-RPC client)
4. Claude provider (new implementation)
5. Agent Runner + Workspace
6. Orchestrator (ties everything together)
7. CLI entry point
8. Dashboard/status reporter

## Key Design Decisions

- **No GenServer**: Use async/await + setInterval for the poll loop
- **No BEAM supervision**: Use try/catch + AbortController for process management
- **Child process management**: `child_process.spawn` for Codex and hooks
- **Concurrency**: Simple counter-based semaphore (no need for p-limit)
- **Provider selection**: Config field `agent.provider: "codex" | "claude"` in WORKFLOW.md
- **Testing**: Vitest with dependency injection (constructor params, not module-level globals)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSpec } from "../tools/tool-specs.js";
import type { ToolResult } from "../providers/types.js";
import { logger } from "../logger.js";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport;
  tools: ToolSpec[];
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private configs: Record<string, McpServerEntry>;
  private initialized = false;

  constructor(configs: Record<string, McpServerEntry>) {
    this.configs = configs;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    for (const [name, config] of Object.entries(this.configs)) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...process.env as Record<string, string>, ...config.env },
          stderr: "pipe",
        });

        const client = new Client({
          name: `symphony-${name}`,
          version: "0.1.0",
        });

        await client.connect(transport);

        const result = await client.listTools();
        const tools: ToolSpec[] = result.tools.map((t) => ({
          name: `mcp__${name}__${t.name}`,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));

        this.servers.set(name, { client, transport, tools });

        logger.info(
          { server: name, toolCount: tools.length },
          "MCP server connected",
        );
      } catch (err) {
        logger.warn(
          { server: name, err },
          "Failed to start MCP server, skipping",
        );
      }
    }
  }

  getToolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const server of this.servers.values()) {
      specs.push(...server.tools);
    }
    return specs;
  }

  canHandle(toolName: string): boolean {
    return toolName.startsWith("mcp__") && this.resolveServer(toolName) !== null;
  }

  async callTool(
    prefixedName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const resolved = this.resolveServer(prefixedName);
    if (!resolved) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: JSON.stringify({ error: `Unknown MCP tool: ${prefixedName}` }) }],
      };
    }

    const { server, toolName } = resolved;

    try {
      const result = await server.client.callTool({ name: toolName, arguments: args });

      // Handle new-style content array
      if ("content" in result && Array.isArray(result.content)) {
        const textParts: string[] = [];
        for (const item of result.content) {
          if (item.type === "text") {
            textParts.push(item.text);
          } else if (item.type === "image") {
            textParts.push(`[Image: ${item.mimeType}, ${item.data.length} bytes base64]`);
          } else if (item.type === "resource") {
            const res = item.resource;
            if ("text" in res) {
              textParts.push(res.text);
            } else {
              textParts.push(`[Binary resource: ${res.uri}]`);
            }
          }
        }

        return {
          success: !result.isError,
          contentItems: [{ type: "inputText", text: textParts.join("\n") || "(empty result)" }],
        };
      }

      // Legacy toolResult format
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      };
    } catch (err) {
      logger.error({ err, tool: prefixedName }, "MCP tool call failed");
      return {
        success: false,
        contentItems: [{ type: "inputText", text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }

  async shutdown(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
      } catch (err) {
        logger.warn({ server: name, err }, "Error closing MCP server");
      }
    }
    this.servers.clear();
  }

  private resolveServer(
    prefixedName: string,
  ): { server: ConnectedServer; toolName: string } | null {
    // Format: mcp__<serverName>__<toolName>
    const match = prefixedName.match(/^mcp__([^_]+(?:__[^_]+)*)__(.+)$/);
    if (!match) return null;

    // Try progressively: the server name could itself contain underscores
    // but in practice we use the config key which shouldn't.
    // Simple approach: split on first __ after mcp__
    const rest = prefixedName.slice(5); // remove "mcp__"
    for (const [serverName, server] of this.servers) {
      const prefix = `${serverName}__`;
      if (rest.startsWith(prefix)) {
        return { server, toolName: rest.slice(prefix.length) };
      }
    }

    return null;
  }
}

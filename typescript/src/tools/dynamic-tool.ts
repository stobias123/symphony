import type { Config } from "../config.js";
import type { ToolResult } from "../providers/types.js";
import { logger } from "../logger.js";

export class DynamicToolExecutor {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case "linear_graphql":
          return await this.executeLinearGraphql(args);
        case "jira_rest":
          return await this.executeJiraRest(args);
        case "confluence_rest":
          return await this.executeConfluenceRest(args);
        default:
          return errorResult(`Unknown tool: ${toolName}`);
      }
    } catch (err) {
      logger.error({ err, toolName }, "Dynamic tool execution failed");
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  private async executeLinearGraphql(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    if (!query) return errorResult("Missing 'query' argument");

    const token = this.config.linearApiToken;
    if (!token) return errorResult("LINEAR_API_KEY not configured");

    const response = await fetch(this.config.linearEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({
        query,
        variables: (args.variables as Record<string, unknown>) ?? {},
      }),
    });

    const body = await response.text();
    return successResult(body);
  }

  private async executeJiraRest(args: Record<string, unknown>): Promise<ToolResult> {
    const method = (args.method as string) ?? "GET";
    const apiPath = args.path as string;
    if (!apiPath) return errorResult("Missing 'path' argument");

    const endpoint = this.config.jiraEndpoint;
    if (!endpoint) return errorResult("Jira endpoint not configured");

    const url = `${endpoint}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;
    const response = await this.makeJiraRequest(url, method, args.body);
    const body = await response.text();
    return successResult(body);
  }

  private async executeConfluenceRest(args: Record<string, unknown>): Promise<ToolResult> {
    const method = (args.method as string) ?? "GET";
    const apiPath = args.path as string;
    if (!apiPath) return errorResult("Missing 'path' argument");

    const endpoint = this.config.confluenceEndpoint;
    if (!endpoint) return errorResult("Confluence endpoint not configured");

    const url = `${endpoint}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;
    const response = await this.makeConfluenceRequest(url, method, args.body);
    const body = await response.text();
    return successResult(body);
  }

  private async makeJiraRequest(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.jiraAuthHeaders(),
    };

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async makeConfluenceRequest(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.confluenceAuthHeaders(),
    };

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private jiraAuthHeaders(): Record<string, string> {
    const email = this.config.jiraEmail;
    const token = this.config.jiraApiToken;
    if (!token) return {};

    if (email) {
      return {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      };
    }
    return { Authorization: `Bearer ${token}` };
  }

  private confluenceAuthHeaders(): Record<string, string> {
    const user = this.config.confluenceUser;
    const token = this.config.confluenceToken;
    if (!token) return {};

    if (user) {
      return {
        Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
      };
    }
    return { Authorization: `Bearer ${token}` };
  }
}

function successResult(text: string): ToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

function errorResult(message: string): ToolResult {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
  };
}

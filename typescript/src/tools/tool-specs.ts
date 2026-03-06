export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const linearGraphqlTool: ToolSpec = {
  name: "linear_graphql",
  description:
    "Execute a raw Linear GraphQL query or mutation. Use for reading or modifying Linear data.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The GraphQL query or mutation string" },
      variables: {
        type: "object",
        description: "Optional variables for the GraphQL operation",
      },
    },
    required: ["query"],
  },
};

export const jiraRestTool: ToolSpec = {
  name: "jira_rest",
  description: "Execute a raw Jira REST API request.",
  inputSchema: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE"],
        description: "HTTP method",
      },
      path: {
        type: "string",
        description: "API path (e.g. /rest/api/3/issue/KEY-123)",
      },
      body: {
        type: "object",
        description: "Optional JSON body for POST/PUT requests",
      },
    },
    required: ["method", "path"],
  },
};

export const confluenceRestTool: ToolSpec = {
  name: "confluence_rest",
  description: "Execute a raw Confluence REST API request.",
  inputSchema: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE"],
        description: "HTTP method",
      },
      path: {
        type: "string",
        description: "API path (e.g. /rest/api/content/12345)",
      },
      body: {
        type: "object",
        description: "Optional JSON body for POST/PUT requests",
      },
    },
    required: ["method", "path"],
  },
};

export function getToolSpecs(trackerKind: string | undefined): ToolSpec[] {
  switch (trackerKind) {
    case "jira":
      return [jiraRestTool, confluenceRestTool];
    case "linear":
      return [linearGraphqlTool];
    default:
      return [linearGraphqlTool];
  }
}

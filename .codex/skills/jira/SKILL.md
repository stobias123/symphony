---
name: jira
description: |
  Use Symphony's `jira_rest` client tool for Jira REST API
  operations such as issue transitions, comment editing, and search.
---

# Jira REST API

Use this skill for Jira API work during Symphony app-server sessions.

## Primary tool

Use the `jira_rest` client tool exposed by Symphony's app-server session.
It reuses Symphony's configured Jira auth for the session.

Tool input:

```json
{
  "method": "GET | POST | PUT | DELETE",
  "path": "/rest/api/3/...",
  "body": { "optional": "json body" },
  "query": { "optional": "query params" }
}
```

Tool behavior:

- Send one REST call per tool use.
- Check the `success` field in the response; non-2xx status codes return `success: false` with the status and error body.
- Keep requests narrowly scoped; request only the fields you need via query params.

## Common workflows

### Get an issue by key

```json
{
  "method": "GET",
  "path": "/rest/api/3/issue/PROJ-123",
  "query": { "fields": "summary,status,description,assignee,labels,priority,issuelinks,comment" }
}
```

### Search issues with JQL

```json
{
  "method": "GET",
  "path": "/rest/api/3/search",
  "query": {
    "jql": "project = PROJ AND status = \"In Progress\"",
    "fields": "summary,status,assignee",
    "maxResults": "50"
  }
}
```

### Transition an issue (change status)

Transitions require two steps: first get available transitions, then execute one.

Step 1 - Get available transitions:

```json
{
  "method": "GET",
  "path": "/rest/api/3/issue/PROJ-123/transitions"
}
```

Step 2 - Execute the transition using the `id` from step 1:

```json
{
  "method": "POST",
  "path": "/rest/api/3/issue/PROJ-123/transitions",
  "body": {
    "transition": { "id": "31" }
  }
}
```

### Add a comment

Jira Cloud uses Atlassian Document Format (ADF) for comment bodies:

```json
{
  "method": "POST",
  "path": "/rest/api/3/issue/PROJ-123/comment",
  "body": {
    "body": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "Your comment text here." }
          ]
        }
      ]
    }
  }
}
```

### Update a comment

```json
{
  "method": "PUT",
  "path": "/rest/api/3/issue/PROJ-123/comment/10042",
  "body": {
    "body": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "Updated comment text." }
          ]
        }
      ]
    }
  }
}
```

### Get all comments on an issue

```json
{
  "method": "GET",
  "path": "/rest/api/3/issue/PROJ-123/comment",
  "query": { "orderBy": "-created" }
}
```

### Add a remote link (e.g. attach a PR)

```json
{
  "method": "POST",
  "path": "/rest/api/3/issue/PROJ-123/remotelink",
  "body": {
    "object": {
      "url": "https://github.com/org/repo/pull/42",
      "title": "PR #42: Fix the thing",
      "icon": {
        "url16x16": "https://github.com/favicon.ico",
        "title": "GitHub"
      }
    }
  }
}
```

### Add labels to an issue

```json
{
  "method": "PUT",
  "path": "/rest/api/3/issue/PROJ-123",
  "body": {
    "update": {
      "labels": [{ "add": "symphony" }]
    }
  }
}
```

### Get project statuses (for discovering transition targets)

```json
{
  "method": "GET",
  "path": "/rest/api/3/project/PROJ/statuses"
}
```

## ADF (Atlassian Document Format) reference

Jira Cloud API v3 uses ADF for rich text fields. Key node types:

- `doc` - root node (always `version: 1`)
- `paragraph` - text block
- `text` - inline text (inside paragraph)
- `heading` - heading with `attrs.level` (1-6)
- `bulletList` / `orderedList` - lists containing `listItem` nodes
- `codeBlock` - code fence with optional `attrs.language`
- `hardBreak` - line break within a paragraph

Text marks: `strong`, `em`, `code`, `link` (with `attrs.href`).

Example with heading + code block:

```json
{
  "type": "doc",
  "version": 1,
  "content": [
    {
      "type": "heading",
      "attrs": { "level": 2 },
      "content": [{ "type": "text", "text": "Workpad" }]
    },
    {
      "type": "codeBlock",
      "attrs": { "language": "text" },
      "content": [{ "type": "text", "text": "hostname:/path@sha" }]
    }
  ]
}
```

## Usage rules

- Use `jira_rest` for issue transitions, comment edits, searches, and ad-hoc Jira API calls.
- Always fetch available transitions before attempting a status change; transition IDs vary per project workflow.
- Use ADF format for all comment and description bodies on Jira Cloud API v3.
- Prefer `/rest/api/3/` endpoints (Jira Cloud v3).
- Do not introduce shell-based API helpers; use the `jira_rest` tool for all Jira operations.

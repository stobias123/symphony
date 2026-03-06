---
name: confluence
description: |
  Use Symphony's `confluence_rest` client tool for Confluence REST API
  operations such as page lookup, content search, and comment edits.
---

# Confluence REST API

Use this skill for Confluence API work during Symphony app-server sessions.

## Primary tool

Use the `confluence_rest` client tool exposed by Symphony's app-server session.
It reuses Symphony's configured Confluence auth for the session.

Tool input:

```json
{
  "method": "GET | POST | PUT | DELETE",
  "path": "/api/v2/...",
  "body": { "optional": "json body" },
  "query": { "optional": "query params" }
}
```

Tool behavior:

- Send one REST call per tool use.
- Check the `success` field in the response; non-2xx status codes return `success: false` with the status and error body.
- Keep requests narrowly scoped and request only needed fields.

## Common workflows

### Get a page by id (v2)

```json
{
  "method": "GET",
  "path": "/api/v2/pages/123456789"
}
```

### Search pages with CQL (v1)

```json
{
  "method": "GET",
  "path": "/rest/api/content/search",
  "query": {
    "cql": "space = ENG and type = page and title ~ \"runbook\"",
    "limit": "25"
  }
}
```

### Create a footer comment on a page

```json
{
  "method": "POST",
  "path": "/rest/api/content/123456789/child/comment",
  "body": {
    "type": "comment",
    "container": {
      "id": "123456789",
      "type": "page"
    },
    "body": {
      "storage": {
        "value": "<p>Comment text.</p>",
        "representation": "storage"
      }
    }
  }
}
```

### Update a page

```json
{
  "method": "PUT",
  "path": "/rest/api/content/123456789",
  "body": {
    "id": "123456789",
    "type": "page",
    "title": "Updated title",
    "version": { "number": 2 },
    "body": {
      "storage": {
        "value": "<p>Updated content.</p>",
        "representation": "storage"
      }
    }
  }
}
```

## Usage rules

- Use `confluence_rest` for Confluence API calls instead of shell helpers.
- Prefer `/api/v2/` endpoints where available; use `/rest/api/` when needed.
- Keep request payloads minimal and scoped to the current task.

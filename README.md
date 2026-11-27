# truelist-mcp

[![Free tier](https://img.shields.io/badge/free_plan-100_validations-4A7C59?style=flat-square)](https://truelist.io/pricing)
MCP (Model Context Protocol) server for [Truelist](https://truelist.io) email finding and validation. Lets AI assistants like Claude, Cursor, and VS Code Copilot find work email addresses and validate them for deliverability.

## What is this?

This package exposes Truelist's email finding and validation API as MCP tools. Once configured, your AI assistant can:

- Find a work email from a name and company domain
- Find emails for a list, then check progress and page the results
- Check if an email address is valid and deliverable
- Validate batches of emails at once
- Check your Truelist account info and plan

Finding requires a paid v7 plan. A verified or no-match result costs 25 enhanced credits. Validation still works on the free plan.

> **Start free** — 100 validations + 10 enhanced credits, no credit card required.
> [Get your API key →](https://app.truelist.io/signup?utm_source=github&utm_medium=readme&utm_campaign=free-plan&utm_content=truelist-mcp)
> Works with the free plan.

## Installation

```bash
npm install -g truelist-mcp
```

Or run directly with `npx`:

```bash
npx truelist-mcp
```

## Configuration

You need a Truelist API key. Get one at [truelist.io](https://truelist.io).

### Claude Desktop

Add to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "truelist": {
      "command": "npx",
      "args": ["truelist-mcp"],
      "env": {
        "TRUELIST_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

Add to your `.claude/settings.json` or run:

```bash
claude mcp add truelist -- npx truelist-mcp
```

Then set the environment variable:

```bash
export TRUELIST_API_KEY=your-api-key
```

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json` in your project or global settings):

```json
{
  "mcpServers": {
    "truelist": {
      "command": "npx",
      "args": ["truelist-mcp"],
      "env": {
        "TRUELIST_API_KEY": "your-api-key"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to your VS Code settings (`.vscode/mcp.json` in your project):

```json
{
  "servers": {
    "truelist": {
      "command": "npx",
      "args": ["truelist-mcp"],
      "env": {
        "TRUELIST_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools

### validate_email

Validate a single email address for deliverability.

**Input:**
```json
{
  "email": "user@example.com"
}
```

**Output:**
```json
{
  "email": "user@example.com",
  "state": "ok",
  "sub_state": "email_ok",
  "suggestion": null,
  "domain": "example.com",
  "canonical": "user@example.com",
  "mx_record": "mx.example.com",
  "first_name": "Jane",
  "last_name": "Doe",
  "verified_at": "2026-02-21T12:00:00Z",
  "is_valid": true,
  "is_deliverable": true
}
```

**States:**
| State | Meaning |
|-------|---------|
| `ok` | Email is deliverable |
| `email_invalid` | Email is not deliverable |
| `risky` | Email may be deliverable but has risk factors |
| `accept_all` | Domain accepts all addresses; deliverability uncertain |
| `unknown` | Could not determine deliverability |

**Sub-states:**
| Sub-state | Meaning |
|-----------|---------|
| `email_ok` | No issues found |
| `accept_all` | Domain accepts all addresses |
| `is_disposable` | Temporary/disposable email |
| `is_role` | Role-based address (info@, support@, etc.) |
| `failed_mx_check` | Domain has no mail server |
| `failed_smtp_check` | SMTP verification failed |
| `failed_spam_trap` | Known spam trap address |
| `failed_no_mailbox` | Mailbox does not exist |
| `failed_greylisted` | Server temporarily rejected |
| `failed_syntax_check` | Invalid email syntax |
| `unknown` | Could not determine sub-state |

### validate_emails

Validate multiple email addresses in a single batch (max 50).

**Input:**
```json
{
  "emails": [
    "user@example.com",
    "test@invalid.example",
    "hello@gmail.com"
  ]
}
```

**Output:**
```json
[
  {
    "email": "user@example.com",
    "state": "ok",
    "sub_state": "email_ok",
    "is_valid": true
  },
  {
    "email": "test@invalid.example",
    "state": "email_invalid",
    "sub_state": "failed_mx_check",
    "is_valid": false
  },
  {
    "email": "hello@gmail.com",
    "state": "ok",
    "sub_state": "email_ok",
    "is_valid": true
  }
]
```

### check_account

Check your Truelist account info including name, email, plan, and admin status.

**Input:** none

**Output:**
```json
{
  "email": "you@company.com",
  "name": "Your Name",
  "uuid": "a3828d19-...",
  "timeZone": "America/New_York",
  "isAdminRole": true,
  "paymentPlan": "pro"
}
```

### find_email

Find one person's work email at a company domain. A verified or no-match result costs 25 enhanced credits. `catch_all`, `no_mx`, and invalid input are free. Requires a paid v7 plan.

**Input:**
```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "domain": "example.com"
}
```

**Output:**
```json
{
  "status": "verified",
  "domain": "example.com",
  "mx_record": "mx.example.com",
  "catch_all": false,
  "credits_charged": 25,
  "checks_used": 3,
  "checks_cap": 8,
  "most_common_pattern": null,
  "available_enhanced_credits": 75,
  "best_match": {
    "key": "first.last",
    "email": "jane@example.com",
    "name_variant": "Jane Doe",
    "email_state": "ok",
    "email_sub_state": "email_ok",
    "verified_at": "2026-11-27T12:00:00Z"
  },
  "patterns": []
}
```

**Statuses:** `verified`, `no_match`, `catch_all`, `no_mx`.

### start_bulk_find

Queue a bulk find for 1 to 10000 people. The call returns when the run is queued. Poll `get_bulk_find`, then page rows with `list_bulk_find_results`. Each verified or no-match row costs 25 enhanced credits. A row that already has an email is skipped. `credit_cap` is the most the run may spend (at least 25, and no more than the enhanced credits available).

**Input:**
```json
{
  "name": "Q4 prospects",
  "credit_cap": 50,
  "rows": [
    {
      "first_name": "Jane",
      "last_name": "Doe",
      "domain": "example.com"
    },
    {
      "first_name": "Alex",
      "last_name": "Doe",
      "domain": "example.com",
      "email": "alex@example.com"
    }
  ]
}
```

**Output:**
```json
{
  "id": "a3b9f1e2-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
  "name": "Q4 prospects.csv",
  "run": {
    "id": "b4c0a2f3-5d6e-7f80-9b1c-2d3e4f5a6b7c",
    "trigger": "manual",
    "steps": ["find"],
    "status": "running",
    "stopped_at_cap": false,
    "credit_cap": 50,
    "credits_used": 0,
    "started_at": "2026-11-27T12:00:00Z",
    "finished_at": null,
    "find": {
      "eligible": 1,
      "processed": 0,
      "in_flight": 0,
      "found": 0,
      "no_match": 0,
      "no_confident_match": 0,
      "no_mx": 0,
      "invalid_input": 0,
      "error": 0,
      "duplicates": 0,
      "not_processed": 1
    }
  }
}
```

### get_bulk_find

Read the list and its latest run. This does not spend credits. Keep calling it until `run.status` is no longer `running`.

**Input:**
```json
{
  "list_id": "a3b9f1e2-4c5d-6e7f-8a9b-0c1d2e3f4a5b"
}
```

**Output:** the same `id`, `name`, and `run` object as `start_bulk_find`. `run` is null when the list has not started.

### list_bulk_find_results

Page the rows of a bulk find. `counts` is one integer for every find status, on every page: `verified`, `no_match`, `skipped`, `searching`, `not_processed`, `no_confident_match`, `no_mx`, `invalid_input`, and `error`. Pass `offset` back as `next_offset` until `has_more` is false. `found_email` is present only for a verified row. Reading results does not spend credits.

**Input:**
```json
{
  "list_id": "a3b9f1e2-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
  "find_status": "verified",
  "limit": 25,
  "offset": 0
}
```

**Output:**
```json
{
  "id": "a3b9f1e2-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
  "total_count": 1,
  "limit": 25,
  "offset": 0,
  "has_more": false,
  "next_offset": null,
  "counts": {
    "not_processed": 0,
    "skipped": 1,
    "searching": 0,
    "verified": 1,
    "no_match": 0,
    "no_confident_match": 0,
    "no_mx": 0,
    "invalid_input": 0,
    "error": 0
  },
  "rows": [
    {
      "csv_line": 1,
      "first_name": "Jane",
      "last_name": "Doe",
      "domain": "example.com",
      "find_status": "verified",
      "reason": null,
      "found_email": "jane@example.com",
      "credits_charged": 25
    }
  ]
}
```

`find_status`, `limit` (default 25, max 100), and `offset` (default 0) are optional.

### Finder errors

A finder failure is a tool error whose message starts with a stable code:

| Code | When |
|------|------|
| `plan_not_supported` | Free, non-v7, or unpaid plan |
| `insufficient_credits` | Fewer than 25 enhanced credits. `find_email` and `start_bulk_find` return this. Progress and results stay readable |
| `rate_limited` | The shared API rate limit |
| `invalid_input` | A name, domain, row, or find status the finder rejects |
| `invalid_credit_cap` | The cap is missing, below 25, or above the available balance |
| `not_found` | The list is not on this account |
| `unauthorized` | The API key is missing or invalid |
| `file_too_large` | The generated list is over the upload limit |

These tools do not return `payment_required`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUELIST_API_KEY` | Yes | Your Truelist API key from [truelist.io](https://truelist.io) |

## Troubleshooting

### "TRUELIST_API_KEY environment variable is required"

The server requires a `TRUELIST_API_KEY` environment variable. Make sure it's set in your MCP configuration's `env` block or exported in your shell.

### Tool not showing up in Claude/Cursor

1. Restart your AI assistant after changing the MCP configuration
2. Check that `npx truelist-mcp` runs without errors when `TRUELIST_API_KEY` is set
3. Verify the config file path is correct for your platform

### Authentication errors

Verify your API key is correct and active at [truelist.io](https://truelist.io).

### Rate limiting

Truelist enforces rate limits on the API. If you hit rate limits, the SDK will automatically retry with exponential backoff. For batch validation, emails are validated concurrently so large batches may trigger rate limits.


## Getting Started

Sign up for a [free Truelist account](https://app.truelist.io/signup?utm_source=github&utm_medium=readme&utm_campaign=free-plan&utm_content=truelist-mcp) to get your API key. The free plan includes 100 validations and 10 enhanced credits — no credit card required.
## License

MIT

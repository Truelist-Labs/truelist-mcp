# Changelog

## 0.2.0 (2026-11-27)

- `find_email` finds one work email from a name and domain
- `start_bulk_find` queues a bulk find (1 to 10000 rows)
- `get_bulk_find` returns the list and its latest run
- `list_bulk_find_results` pages the rows. `counts` includes every find status (`verified`, `no_match`, `skipped`, `searching`, and the rest) on every page
- Finder errors are `plan_not_supported`, `insufficient_credits`, and `rate_limited`. A `payment_required` body is reported as `insufficient_credits`

## 0.1.1 (2026-10-15)

- Add `mcpName` and `server.json` for listing in the official MCP Registry as `io.truelist/mcp`

## 0.1.0 (2026-02-20)

- Initial release
- `validate_email` tool for single email validation
- `validate_emails` tool for batch validation (up to 50 emails)
- `check_account` tool for account info and credits

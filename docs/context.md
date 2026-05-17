# Token Deck Context

## Research Summary

Token Deck should start as a thin Stream Deck plugin that consumes CodexBar
instead of duplicating provider integrations.

CodexBar facts used for this prototype:

- `codexbar usage --format json --json-only` returns provider usage JSON.
- `codexbar cost --format json --json-only` exists for local Codex/Claude cost
  scans, but it is not the first UI target.
- `codexbar serve` exposes `GET /health`, `GET /usage`, and `GET /cost` on
  `127.0.0.1`.
- CodexBar is MIT licensed, but it is a Swift project. Reusing its internals
  directly would complicate a Stream Deck plugin, so the CLI/HTTP boundary is
  the cleaner first step.

Stream Deck facts used for this prototype:

- Current SDK plugins run a Node.js backend.
- Keys support dynamic title and image updates.
- Stream Deck Neo has LCD keys suitable for compact status display.

## Design Choice

The data source is explicit. Token Deck does not silently fall back between
data sources.

CLI mode runs a short-lived command on each refresh:

```bash
codexbar usage --provider <provider> --format json --json-only
```

HTTP mode reads a running CodexBar service:

```text
http://127.0.0.1:8080/usage?provider=<provider>
```

Within the selected mode, connection fields are allowed to be automatic. Empty
`CLI Path` means the plugin tries common Homebrew install paths before using
`codexbar` from `PATH`. Empty `HTTP Endpoint` means the plugin constructs the
local `/usage` URL from the configured `HTTP Port`.

The CLI parser intentionally scans stdout for the JSON payload because Codex
notifications can be prepended before the JSON block. The refresh loop also
prevents overlapping CodexBar calls for the same key.

## Next Decisions

- Whether a managed-service mode is worth adding later, where the plugin starts
  and supervises `codexbar serve` itself.
- Whether `provider=all` should rotate providers or render the lowest remaining
  provider.
- Whether CodexBar should expose a smaller, Stream Deck-specific summary
  endpoint upstream.

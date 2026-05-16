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

Use this priority order:

1. Poll `http://127.0.0.1:8080/usage?provider=<provider>`.
2. If HTTP fails and mode is `auto`, call:

```bash
codexbar usage --provider <provider> --format json --json-only
```

The CLI fallback intentionally scans stdout for the JSON payload because Codex
notifications can be prepended before the JSON block.

## Next Decisions

- Whether the plugin should start and supervise `codexbar serve` itself.
- Whether `provider=all` should rotate providers or render the lowest remaining
  provider.
- Whether CodexBar should expose a smaller, Stream Deck-specific summary
  endpoint upstream.

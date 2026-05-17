# AGENTS.md

## Project

Token Deck is a Stream Deck plugin that displays AI provider quota and token
usage on LCD keys. The first implementation uses CodexBar as the local data
source instead of reimplementing provider integrations.

## Architecture

- Stream Deck plugin runtime: Node.js/TypeScript via `@elgato/streamdeck`.
- Data source mode is explicit. `CLI` runs short-lived
  `codexbar usage --format json --json-only` calls. `HTTP` reads an existing
  `codexbar serve` endpoint. Do not add silent switching between modes.
- `CLI Path` and `HTTP Endpoint` are optional overrides. Empty values should use
  the built-in discovery/default URL for the selected mode.
- Key rendering: generate SVG in the plugin and send it with `setImage`.
- Do not store provider tokens or cookies in this project. CodexBar owns
  provider auth, config, and cache.

## Development

- Build with `npm run build`.
- Use `npm run watch` while testing inside the Stream Deck app.
- Keep the plugin UUID stable: `com.leask.token-deck`.
- Keep UI text compact enough for Stream Deck Neo keys.

## Current MVP Scope

- One action: AI Token Usage.
- Default provider: Codex.
- Settings: provider, data source mode, HTTP port, refresh interval, custom
  endpoint, CLI path.
- Manual key press forces refresh.

## Follow-up Ideas

- Add multi-provider rotation for `provider=all`.
- Add threshold-based color and alert settings.
- Add a managed-service mode only if the plugin can own the service lifecycle.
- Replace temporary scaffold icons with dedicated Token Deck assets.

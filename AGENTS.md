# AGENTS.md

## Project

Token Deck is a Stream Deck plugin that displays AI provider quota and token
usage, plus local Mac hardware status, on Stream Deck LCD keys. Token usage
uses CodexBar as the local data source instead of reimplementing provider
integrations.

## Architecture

- Stream Deck plugin runtime: Node.js/TypeScript via `@elgato/streamdeck`.
- Data source mode is explicit. `CLI` runs short-lived
  `codexbar usage --format json --json-only` calls. `HTTP` reads an existing
  `codexbar serve` endpoint. Do not add silent switching between modes.
- `CLI Path` and `HTTP Endpoint` are optional overrides. Empty values should use
  the built-in discovery/default URL for the selected mode.
- Hardware status actions read local macOS state directly. Do not require sudo,
  `powermetrics`, or a long-running helper service in the refresh path.
- Key rendering: generate SVG in the plugin and send it with `setImage`.
- Do not store provider tokens or cookies in this project. CodexBar owns
  provider auth, config, and cache.

## Development

- Build with `npm run build`.
- Type-check with `npx tsc --noEmit`.
- Validate with `streamdeck validate com.leask.token-deck.sdPlugin`.
- Use `npm run watch` while testing inside the Stream Deck app.
- Keep the plugin UUID stable: `com.leask.token-deck`.
- Keep UI text compact enough for Stream Deck Neo keys.
- Runtime logs are under
  `com.leask.token-deck.sdPlugin/logs/com.leask.token-deck.0.log`.

## Current Scope

- `AI Token Usage`: provider, explicit data source mode, HTTP port, refresh
  interval, custom endpoint, and CLI path.
- Hardware actions: CPU, memory, disk, GPU, network, temperature, battery, and
  power.
- Manual key press forces refresh for every action.
- Background refresh should keep the previous good image visible and overlay a
  small refreshing indicator, not blank the key.

## Follow-up Ideas

- Add multi-provider rotation for `provider=all`.
- Add threshold-based color and alert settings.
- Add a managed-service mode only if the plugin can own the service lifecycle.
- Replace temporary scaffold icons with dedicated Token Deck assets.

# Token Deck

![Stream Deck Photo](https://github.com/user-attachments/assets/6f1d6ae6-cc68-42c5-900d-fdfeb78be87a)

Token Deck is a Stream Deck plugin for showing AI provider quota, token usage,
and Mac hardware status on Stream Deck keys. Token usage can be read through
[CodexBar](https://github.com/steipete/CodexBar) or directly from an existing
[OpenCode](https://github.com/anomalyco/opencode) credential store. Hardware
actions read local macOS status directly.

![Token Deck Screenshot](https://github.com/user-attachments/assets/2d8ac047-c8cd-4c4b-9316-11a5033baf5a)

## Requirements

- macOS with Elgato Stream Deck 7.1 or newer.
- Node.js 24 or newer.
- CodexBar installed and configured when using `CodexBar CLI` or `CodexBar HTTP`.
- OpenCode authenticated when using the `OpenCode` data source.

By default, the plugin uses `CodexBar CLI` mode and runs a short-lived CodexBar
command at each refresh:

```bash
codexbar usage --provider codex --source oauth --format json --json-only
```

For non-Codex providers, Token Deck keeps CodexBar's provider-specific default
source selection. CLI subprocesses receive common Homebrew and system bin paths
so Stream Deck can find provider CLIs without inheriting your login shell PATH.

`CodexBar HTTP` mode reads an explicitly running CodexBar JSON service:

```bash
codexbar serve --port 8080 --refresh-interval 60
```

`OpenCode` mode reads existing credentials from OpenCode's local auth store. It
currently supports:

- `Codex` through the existing OpenAI OAuth credential.
- `OpenCode Go` through the existing OpenCode Go API credential.

Token Deck does not copy credentials into Stream Deck settings. OpenAI OAuth
refreshes are written back to the same OpenCode auth store while preserving the
other provider credentials. `OPENCODE_AUTH_CONTENT` is also supported as a
read-only credential source.

OpenCode Go exposes rolling, weekly, and monthly quota windows. Token Deck can
render all three windows on one key.

The `Codex ↔ OpenCode Go` provider mode refreshes both OpenCode-backed snapshots
on the normal refresh timer and rotates the displayed snapshot independently.
The default rotation interval is 10 seconds. Rotation is in-memory only and does
not trigger additional network requests. Pressing the key switches provider
immediately and restarts the rotation timer.

Custom CodexBar connection fields remain optional. If `CLI Path` is empty, Token
Deck checks common Homebrew paths and then runs `codexbar` from `PATH`. If
`HTTP Endpoint` is empty, Token Deck builds
`http://127.0.0.1:<port>/usage` from the `HTTP Port` setting.

## Architecture

- Stream Deck runtime: Node.js/TypeScript via `@elgato/streamdeck`.
- Token usage sources: explicit `CodexBar CLI`, `CodexBar HTTP`, or `OpenCode`.
- OpenCode source: local credential reuse for Codex/OpenAI and OpenCode Go.
- Multi-provider mode: separate in-memory snapshots with independent UI rotation.
- Hardware sources: macOS system commands and Apple SMC readings, kept
  independent from token providers.
- Rendering: each action generates a compact SVG image and sends it to the key
  with `setImage`.
- Refresh: every key refreshes on its timer; multi-provider rotation does not
  refresh provider data.

## Development

```bash
npm install
npm run build
npm run watch
```

The official Stream Deck CLI linked the plugin into:

```text
~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.leask.token-deck.sdPlugin
```

The link points back to this checkout's `com.leask.token-deck.sdPlugin`
directory.

## Actions

`AI Token Usage` renders:

- provider name
- remaining percentage for the primary quota window
- secondary quota window when available
- tertiary quota window when available

For normal single-provider actions, pressing the key forces a refresh. In
`Codex ↔ OpenCode Go` mode, pressing the key switches immediately to the other
cached provider snapshot.

Hardware status actions can be added as separate keys without changing the
token key:

- `CPU Status`
- `Memory Status`
- `Disk Status`
- `GPU Status`
- `Network Status`
- `Temperature Status`
- `Battery Status`
- `Power Status`

The hardware keys refresh automatically and also refresh immediately when
pressed.

`CPU Status` samples aggregate CPU activity over a short interval.

`Memory Status` shows current used memory based on Node's OS memory counters.

`Disk Status` aggregates mounted local physical storage and skips network
mounts, Time Machine local snapshots, and disk images. On macOS APFS volumes are
deduplicated by container, so the internal Data volume and an external USB disk
array are counted once each instead of counting every APFS system volume.

`GPU Status` reads Apple Silicon GPU utilization from `IOAccelerator` when that
counter is exposed by macOS.

`Network Status` samples local interface counters and shows combined download
and upload throughput. Loopback, bridge, AWDL, and other virtual interfaces are
ignored.

`Temperature Status` uses Apple SMC temperature readings when available. If the
native sensor module cannot be loaded in the Stream Deck runtime, it falls back
to macOS thermal pressure from `pmset -g therm` instead of showing an error.

`Battery Status` uses `pmset -g batt` on macOS. It shows internal battery level
on laptops, UPS charge on desktop Macs with a supported UPS, and AC/no battery
when no battery source is present.

`Power Status` reads Apple SMC power keys without requiring sudo. If SMC power
is unavailable, it falls back to Apple power telemetry from `ioreg`, then to
voltage/current-derived power on systems that expose battery amperage.

## Validation

Use these checks before shipping a local change:

```bash
npx tsc --noEmit
npm run build
streamdeck validate com.leask.token-deck.sdPlugin
streamdeck restart com.leask.token-deck
```

Runtime logs are written under:

```text
com.leask.token-deck.sdPlugin/logs/com.leask.token-deck.0.log
```

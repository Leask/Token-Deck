# Token Deck

Token Deck is a Stream Deck plugin for showing AI provider quota and token
usage on a key. It is currently a local prototype powered by
[CodexBar](https://github.com/steipete/CodexBar).

## Requirements

- macOS with Elgato Stream Deck 7.1 or newer.
- Node.js 24 or newer.
- CodexBar installed and configured.

By default, the plugin uses `CLI` mode and runs a short-lived CodexBar command
at each refresh:

```bash
codexbar usage --provider codex --format json --json-only
```

`HTTP` mode reads an explicitly running CodexBar JSON service:

```bash
codexbar serve --port 8080 --refresh-interval 60
```

The plugin never switches data sources automatically. Pick `CLI` or `HTTP` in
the action settings.

Custom connection fields are optional. If `CLI Path` is empty, Token Deck checks
the common Homebrew paths and then runs `codexbar` from `PATH`. If
`HTTP Endpoint` is empty, Token Deck builds `http://127.0.0.1:<port>/usage` from
the `HTTP Port` setting.

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

## Current Actions

`AI Token Usage` renders:

- provider name
- remaining percentage for the primary quota window
- primary reset countdown
- secondary quota mini bar

Pressing the key forces a refresh.

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

`Disk Status` aggregates mounted local physical storage and skips network
mounts, Time Machine local snapshots, and disk images. On macOS APFS volumes are
deduplicated by container, so the internal Data volume and an external USB disk
array are counted once each instead of counting every APFS system volume.

`Temperature Status` uses Apple SMC temperature readings when available. If the
native sensor module cannot be loaded in the Stream Deck runtime, it falls back
to macOS thermal pressure from `pmset -g therm` instead of showing an error.

`Battery Status` uses `pmset -g batt` on macOS. It shows internal battery level
on laptops, UPS charge on desktop Macs with a supported UPS, and AC/no battery
when no battery source is present.

`Power Status` reads Apple SMC power keys without requiring sudo. If SMC power
is unavailable, it falls back to Apple power telemetry from `ioreg`, then to
voltage/current-derived power on systems that expose battery amperage.

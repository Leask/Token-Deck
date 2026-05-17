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

The hardware keys refresh automatically and also refresh immediately when
pressed.

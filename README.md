# Token Deck

Token Deck is a Stream Deck plugin for showing AI provider quota and token
usage on a key. It is currently a local prototype powered by
[CodexBar](https://github.com/steipete/CodexBar).

## Requirements

- macOS with Elgato Stream Deck 7.1 or newer.
- Node.js 24 or newer.
- CodexBar installed and configured.

The easiest data path is to run CodexBar as a local JSON service:

```bash
codexbar serve --port 8080 --refresh-interval 60
```

The plugin can also call the `codexbar` CLI directly when HTTP is unavailable.

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

## Current Action

`AI Token Usage` renders:

- provider name
- remaining percentage for the primary quota window
- primary reset countdown
- secondary quota mini bar

Pressing the key forces a refresh.

# Token Deck Context

## Current State

Token Deck is a Stream Deck plugin for compact status keys:

- `AI Token Usage` shows CodexBar quota/token usage.
- Hardware actions show CPU, memory, disk, GPU, network, temperature, battery,
  and system power status.

The token action remains a thin CodexBar client instead of duplicating provider
integrations. The hardware actions are local macOS readers and do not depend on
CodexBar.

## Token Data Source

The token data source is explicit. Token Deck does not silently fall back
between data sources.

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

## Hardware Data Sources

- CPU and memory use Node's `os` module.
- Disk uses `df -k -P -l` plus `diskutil info -plist` on macOS to aggregate
  local physical storage and deduplicate APFS containers.
- GPU reads `IOAccelerator` counters from `ioreg`.
- Network samples `netstat -ibn` and skips virtual/noisy interfaces.
- Temperature reads `osx-temperature-sensor`/SMC first, then falls back to
  `pmset -g therm`.
- Battery reads `pmset -g batt`, which covers internal batteries and supported
  UPS devices.
- Power reads SMC keys `PSTR`, `PDTR`, and `PD0R` first, then falls back to
  AppleSmartBattery telemetry and voltage/current calculations.

Hardware actions should degrade to an explicit unknown/error visual if a metric
is not available. They should not require sudo or long-running helper services.

## Runtime Notes

- Each key renders SVG and sends it with `setImage`; titles are cleared.
- Timed refreshes keep the last successful image visible while showing a small
  refresh badge.
- Manual key press forces an immediate refresh.
- Plugin logs live at
  `com.leask.token-deck.sdPlugin/logs/com.leask.token-deck.0.log`.

## Next Decisions

- Whether a managed-service mode is worth adding later, where the plugin starts
  and supervises `codexbar serve` itself.
- Whether `provider=all` should rotate providers or render the lowest remaining
  provider.
- Whether CodexBar should expose a smaller, Stream Deck-specific summary
  endpoint upstream.
- Whether hardware actions need user-configurable thresholds.
- Whether to replace temporary scaffold icons with dedicated Token Deck assets.

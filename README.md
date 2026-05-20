# Azure Pipelines TUI

A terminal UI for live-following Azure DevOps pipeline runs, with streaming logs via SignalR.

```
┌ Pipeline ──────────────┐┌ Logs — Initialize job ──────────────────────────────┐
│ ▼ ✓ build              ││ ##[section]Starting: Initialize job                  │
│   ▶ ✓ Initialize job   ││ Agent name: 'myorg-pool-agent-abc123'                │
│   ▶ ▶ Terraform plan   ││ Agent machine name: 'myorg-pool-agent-abc123'        │
│   ○ Terraform apply    ││ Current agent version: '4.273.0'                     │
│ ⊘ 14 stages skipped   ││ Agent running as: 'agentuser'                        │
└────────────────────────┘└──────────────────────────────────────────────────────┘
```

## Requirements

- Node.js 18+
- Azure CLI (`az`) signed in to the correct tenant
- `npm install`

## Usage

### TUI — `index.ts`

```bash
# Full build URL
npx tsx index.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=1234

# URL + separate buildId
npx tsx index.ts https://dev.azure.com/ORG/PROJECT 1234

# org/project shorthand
npx tsx index.ts ORG/PROJECT 1234

# Separate arguments
npx tsx index.ts ORG PROJECT 1234

# Keep timestamps in log output
npx tsx index.ts ORG/PROJECT 1234 --keep-timestamps
```

#### Key bindings

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate tree / scroll logs |
| `Enter` `→` | Expand / select step |
| `←` `Esc` | Collapse / back to tree |
| `Tab` | Switch focus between tree and log panel |
| `f` `End` | Follow mode — tail the log |
| `q` `Ctrl+C` | Quit |

### Debug — `debugSignalR.ts`

Dumps all raw SignalR frames to stdout. Useful for exploring the protocol.

```bash
# Full build URL
npx tsx debugSignalR.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=1234

# URL + separate buildId
npx tsx debugSignalR.ts https://dev.azure.com/ORG/PROJECT 1234

# org/project shorthand
npx tsx debugSignalR.ts ORG/PROJECT 1234
```

## How it works

The TUI combines two data sources:

1. **REST polling** (every 500 ms) — fetches build status, timeline records, and log lines via the Azure DevOps REST API.
2. **SignalR** (ASP.NET SignalR 1.x over WebSocket) — receives live events as log lines are written.

### SignalR connection

The connection requires three GUIDs, each from a different source:

| Name | Source | Used in |
|------|--------|---------|
| `instanceId` | `GET /_apis/connectionData` | negotiate and start URLs |
| `projectId` | `GET /_apis/projects/{name}` | WebSocket connect path |
| `contextToken` | negotiate response `.Url` field | connect query parameter |

```
negotiate → wss://...connect → /start → WatchBuild(projectId, buildId)
```

The WebSocket requires the bearer token in two places — as an `Authorization` header and as the `Sec-WebSocket-Protocol` subprotocol value, otherwise the server responds with a 302 redirect.

### Hub events

| Method | Action |
|--------|--------|
| `logConsoleLines` | Streams log lines directly into the log panel |
| `timelineRecordsUpdated` | Triggers a REST poll to refresh the tree |
| `buildUpdated` / `buildUpdated2` | Triggers a REST poll to refresh the header |

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Blessed TUI: tree + log panel |
| `signalr.ts` | SignalR client (negotiate → connect → start → invoke) |
| `debugSignalR.ts` | Standalone debug script |
| `signalr-messages.jsonl` | Runtime dump of all SignalR frames (written by `signalr.ts`) |
| `signalr-negotiate.json` | Runtime dump of the negotiate response |

## Note
We reverse engineered this undocumented streaming API by downloading the following javascript bundles and feeding them to Claude:

* https://cdn.vsassets.io/ext/ms.vss-build-web/run/ms.vss-build-web.run.es6.Utcc_6.min.js
* https://cdn.vsassets.io/ext/ms.vss-features/signalr/ms.vss-features.signalr.es6.yu31LS.min.js
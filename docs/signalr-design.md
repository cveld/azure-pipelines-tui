# Azure DevOps SignalR — Design & Key Learnings

## Overview

The TUI uses ASP.NET SignalR 1.x over WebSocket to stream live log lines and build events without polling. The connection flow is:

```
negotiate → wss://...connect → /start → WatchBuild(projectId, buildId)
```

The WebSocket requires the bearer token in two places — as an `Authorization` header and as the `Sec-WebSocket-Protocol` subprotocol value, otherwise the server responds with a 302 redirect.

## Hub Events

| Method | Action |
|--------|--------|
| `logConsoleLines` | Streams log lines directly into the log panel |
| `timelineRecordsUpdated` | Triggers a REST poll to refresh the tree |
| `buildUpdated` / `buildUpdated2` | Triggers a REST poll to refresh the header |

---

# URL Structure (ASP.NET SignalR 1.x)

## URL Structure (ASP.NET SignalR 1.x)

Three GUIDs matter:

| Name | Source | Used in |
|------|--------|---------|
| `instanceId` | `GET /_apis/connectionData` → `.instanceId` | negotiate URL, start URL |
| `projectId` | `GET /_apis/projects/{name}` → `.id` | WebSocket connect path |
| `contextToken` | negotiate response `.Url` field (regex `/_apis/([guid])/`) | connect query param |

### URL patterns
```
negotiate: https://dev.azure.com/_signalr/{org}/_apis/{instanceId}/signalr/negotiate
connect:   wss://dev.azure.com/_signalr/{org}/_apis/{projectId}/signalr/connect?...&contextToken={contextToken}
start:     https://dev.azure.com/_signalr/{org}/_apis/{instanceId}/signalr/start
```

## WebSocket Auth

Add both headers to the WebSocket constructor:
```ts
headers: {
  Authorization: `Bearer ${token}`,
  "Sec-WebSocket-Protocol": `Bearer, ${token}`,
}
```
(The browser sends the token as the WebSocket subprotocol; without this you get a 302 redirect.)

## Hub Methods

### Subscribe
```ts
ws.send(JSON.stringify({ H: "builddetailhub", M: "WatchBuild", A: [projectId, buildId], I: "1" }));
// Exact signature confirmed from server error: WatchBuild(projectId:Guid, buildId:Int32):Task
```

### Incoming log events
```
method: "logConsoleLines"
args[0]: { lines: string[], stepRecordId: string, timelineRecordId: string, buildId: number }
```
Map `stepRecordId` → `records.find(r => r.id === stepRecordId)` → `rec.log.id` → `logCache`.

### Other hub methods (trigger REST poll)
- `timelineRecordsUpdated` (camelCase from server)
- `BuildUpdated`, `TimelineUpdated`, `JobAssigned`, `JobStarted`, `JobCompleted`

# Note
The SignalR streaming API is undocumented. We reverse-engineered it by downloading and analysing the Azure DevOps web app bundles with Claude:

* https://cdn.vsassets.io/ext/ms.vss-build-web/run/ms.vss-build-web.run.es6.Utcc_6.min.js
* https://cdn.vsassets.io/ext/ms.vss-features/signalr/ms.vss-features.signalr.es6.yu31LS.min.js
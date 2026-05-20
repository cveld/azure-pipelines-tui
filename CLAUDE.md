# Azure DevOps SignalR — Key Learnings

## SignalR URL Structure (ASP.NET SignalR 1.x)

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

## Files
- `signalr.ts` — SignalR client (negotiate → connect → start → invoke)
- `index.ts` — blessed TUI: tree + log panel, REST polling + SignalR events
- `debugSignalR.ts` — standalone debug script (dumps all messages to console)
- `signalr-messages.jsonl` — runtime log of all SignalR frames (written by signalr.ts)
- `signalr-negotiate.json` — runtime dump of negotiate response

## Running
```
npx tsx index.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=<id>
npx tsx debugSignalR.ts ORG/PROJECT <buildId>
```

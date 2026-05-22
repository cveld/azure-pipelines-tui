# Azure Pipelines TUI

## Files

### Source (`src/`)
- `src/tui.ts` — unified TUI entry point: CLI parsing, navigation coordinator, header/footer
- `src/signalr.ts` — SignalR client (negotiate → connect → start → invoke)
- `src/cache.ts` — file-based cache

#### `src/lib/` — shared utilities (no blessed, no side effects)
- `src/lib/types.ts` — all domain interfaces and types
- `src/lib/api.ts` — getToken, HTTP helpers, all ADO API fetch functions
- `src/lib/format.ts` — formatting helpers, tree builders, stage/run helpers

#### `src/screens/` — TUI screens (blessed widgets + keyboard handlers)
- `src/screens/context.ts` — AppContext interface, View type, NavDestination type
- `src/screens/PipelinesScreen.ts` — pipeline definitions tree (default landing)
- `src/screens/EnvironmentsScreen.ts` — environments tree with deployment status
- `src/screens/StagesScreen.ts` — stages dashboard (plan/apply per branch across runs)
- `src/screens/PipelineRunsScreen.ts` — chronological list of runs per pipeline
- `src/screens/PipelineRunScreen.ts` — single build run: timeline tree + live log (SignalR)
- `src/screens/MappingScreen.ts` — environment ↔ pipeline mapping editor

#### Legacy (still functional, superseded by `src/tui.ts`)
- `src/index.ts` — original single-build TUI
- `src/environments-dashboard.ts` — original environments/stages TUI

#### Debug scripts
- `src/debugSignalR.ts` — dumps all SignalR messages to console
- `src/debugRetry.ts` — tests stage retry API calls
- `src/debugWarnings.ts` — warning/error counts per stage/job/task for a build

### Docs (`docs/`)
- `docs/signalr-design.md` — SignalR URL structure, auth, and hub methods
- `docs/stages-dashboard-design.md` — design doc for the stages dashboard (layout, data model, algorithm)
- `docs/screens-navigation.md` — all TUI screens, navigation actions, and CLI entry points

### Runtime outputs
- `signalr-messages.jsonl` — runtime log of all SignalR frames (written by signalr.ts)
- `signalr-negotiate.json` — runtime dump of negotiate response

## Running
```
# Unified TUI (src/tui.ts)
npx tsx src/tui.ts ORG/PROJECT                              # Pipelines Overview (default)
npx tsx src/tui.ts ORG/PROJECT --envs                       # Environments Overview
npx tsx src/tui.ts ORG/PROJECT --stages <pipelineId>        # Stages Dashboard
npx tsx src/tui.ts ORG/PROJECT --runs <pipelineId>          # Pipeline Runs List
npx tsx src/tui.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=<id>  # Pipeline Run
npx tsx src/tui.ts ORG/PROJECT <buildId>                    # Pipeline Run

# Debug scripts
npx tsx src/debugSignalR.ts ORG/PROJECT <buildId>
npx tsx src/debugWarnings.ts ORG/PROJECT <buildId>
npx tsx src/debugWarnings.ts ORG/PROJECT <buildId> --logs   # also prints ##[warning] log lines
npx tsx src/debugRetry.ts ORG/PROJECT <buildId> [stageRef]
```

## ADO API gotchas

### Run ordering
The builds API (`/_apis/build/builds`) sorts by `finishTime DESC` by default. Concurrent runs are misordered: a long-running older run finishing last appears first. Always sort client-side by `id DESC` — run IDs are assigned at queue time.

### Skipped stages have no finishTime
Stages with `result === "skipped"` do not have a `finishTime` in the timeline response. Never use `finishTime` to determine recency for skipped stages.

### warningCount on Stage/Phase/Job records
The `warningCount` field on Stage, Phase, and Job timeline records is unreliable (often 0). Always sum `warningCount` bottom-up from leaf (Task) records that have no children.

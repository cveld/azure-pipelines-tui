# Stages Dashboard — Design

## Purpose

Per pipeline, show all stages grouped by branch. At a glance you can see which branch has been successfully deployed (Plan + Apply), and when a run failed, also show the last successful fallback.

## Screen layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Azure Pipelines Environments   ORG / PROJECT                           │  ← header
├─────────────────────────────────────────────────────────────────────────┤
│  Stage / Branch                Plan                  Apply              │  ← col header (no border)
├─────────────────────────────────────────────────────────────────────────┤
│ Stages: Deploy-to-prod  (48 runs)                                       │
│                                                                         │
│  Deploy                                                                 │  ← base group header (bold)
│    main                        ✓ 5m                  ✓ 2h              │  ← branch row
│    feature/PLAT-123            ✗ 30m (✓2d)           -                 │
│    release/v1.2                ✓ 1h                  ✓ 3h              │
│                                                                         │  ← blank separator
│  Infra                                                                  │
│    main                        ✓ 1h                  ✗ 3h (✓1d)       │
│    feature/PLAT-456            ○ wait                -                 │
│                                                                         │
│ ↑↓ Navigate  Enter Open run  r Refresh  Esc Back  q Quit               │  ← footer
└─────────────────────────────────────────────────────────────────────────┘
```

Column widths (visible characters, excluding blessed tags):

| Column         | Width |
|----------------|-------|
| Stage / Branch | 30    |
| Plan           | 22    |
| Apply          | 22    |

---

## Row types

### Base group header

One row per unique stage base. Rendered **bold**. Groups are sorted **alphabetically** by `displayName`.

Two naming conventions are supported:

**Convention 1 — Plan/Apply prefix:**

| Stage name    | Kind  | Base      |
|---------------|-------|-----------|
| `PlanDeploy`  | plan  | Deploy    |
| `ApplyDeploy` | apply | Deploy    |
| `PlanInfra`   | plan  | Infra     |
| `ApplyInfra`  | apply | Infra     |
| `Plan`        | plan  | (empty)   |
| `Apply`       | apply | (empty)   |

**Convention 2 — bare name + Deploy prefix:**

| Stage name     | Kind  | Base  |
|----------------|-------|-------|
| `lrn`          | plan  | lrn   |
| `Deploy lrn`   | apply | lrn   |

A bare stage name is recognised as `plan` only when a corresponding `Deploy <name>` stage exists somewhere across the loaded runs (pre-pass). The `Deploy` prefix is treated equivalently to `Apply`.

**Other:**

| Stage name    | Kind  | Base      |
|---------------|-------|-----------|
| `SomeOther`   | other | SomeOther |

Empty base with both sides present → displayed as `Plan / Apply`.  
Empty base with only plan → displayed as `Plan`.

### Branch row

One row per (base, branch) combination. The branch is the `sourceBranch` from the pipeline run, stripped of the `refs/heads/` prefix.

Column content per row:

```
 <branch padded to 30>  <Plan cell 22>  <Apply cell 22>
```

### Blank separator

After each base group (except the last) there is one blank row.

---

## Status cell format

Function: `statusCell(entry, prevOk, W, dim, prevActive)`

| State                                          | Icon | Color          | Example              |
|------------------------------------------------|------|----------------|----------------------|
| inProgress                                     | ▶    | yellow         | `▶ – (✗2d)`          |
| inProgress + prevActive                        | ▶    | yellow + color | `▶ – (✗2d)`          |
| succeeded with warnings                        | ⚠    | orange #ff8700 | `⚠ 5m`               |
| succeeded                                      | ✓    | green          | `✓ 5m`               |
| failed                                         | ✗    | red            | `✗ 30m`              |
| failed + prevOk                                | ✗    | red + gray     | `✗ 30m (✓2d)`        |
| skipped/canceled + prevActive (succeeded)      | ✓    | green          | `✓ 2d *`             |
| skipped/canceled + prevActive (failed) + prevOk| ✗    | red + gray     | `✗ 2d *(✓5d)`        |
| skipped/canceled + prevActive (failed)         | ✗    | red            | `✗ 2d *`             |
| skipped/canceled, no prevActive, prevOk exists | ✓    | green          | `✓ 2d *`             |
| skipped / canceled, nothing                    | ⊘    | gray           | `⊘ –`                |
| pending                                        | ○    | gray           | `○ -`                |
| no entry                                       | -    | -              | `-`                  |

### Skipped/canceled — promote previous active run

When the latest run was **skipped or canceled**, the stage was not applicable in that run. Show the most recent *active* (non-skipped, non-canceled) run instead, with a ` *` suffix to signal it is not from the most recent run:

```
✓ 2d *      ← last active run succeeded
✗ 2d *      ← last active run failed (no prior success)
✗ 2d *(✓5d) ← last active run failed, but a successful run exists before it
```

Status cells always use **full color** (never dimmed) — the `*` already communicates "not most recent run". Only the branch name text is dimmed for non-primary branches.

### In-progress — show previous finished result

When a stage is **inProgress**, show the previous finished result in parentheses alongside `▶`:

```
▶ – (✓2d)   ← running, last finished was success 2 days ago
▶ – (✗2d)   ← running, last finished was failure 2 days ago
```

This uses `prevActive` (most recent non-skipped/canceled/in-progress run).

### Fallback on failure

When the latest run **failed** and a prior successful run exists:

```
✗ 30m (✓2d)
```

The gray `(✓2d)` shows how long ago the last successful run was. Padding fills the cell to exactly `W` visible characters.

### Time notation (`timeAgo`)

| Difference  | Output  |
|-------------|---------|
| < 1 minute  | `<1m`   |
| minutes     | `5m`    |
| hours       | `3h`    |
| days        | `2d`    |
| no date     | `-`     |

---

## Data model

### `StageInfo`

From the timeline API (`/_apis/build/builds/{id}/timeline`), filtered to `type === "Stage"`:

```typescript
interface StageInfo {
  id: string;
  name: string;
  state: string;        // "pending" | "inProgress" | "completed"
  result?: string;      // "succeeded" | "failed" | "skipped" | "canceled"
  order?: number;
  finishTime?: string;  // ISO 8601 — NOT present on skipped stages
  warningCount?: number; // sum of warningCount from all leaf descendants
}
```

**Important**: `finishTime` is **absent** on skipped stages. Do not rely on it for ordering or comparison.

`warningCount` is computed in `fetchRunStages` by recursively summing `warningCount` from leaf records (records with no children). The raw `warningCount` on Stage/Phase/Job records is often 0 and must not be trusted.

### `RunStageEntry`

Flat copy of the relevant fields for a (run, stage) pair:

```typescript
interface RunStageEntry {
  runId: number;
  result?: string;
  state: string;
  finishTime?: string;
  warningCount?: number;
}
```

### `StageBranchSummary`

Per (stage base, branch) combination:

```typescript
interface StageBranchSummary {
  branch: string;
  planLatest?:      RunStageEntry;  // most recent run (any result/state)
  planPrevActive?:  RunStageEntry;  // most recent non-skipped/canceled/in-progress run
                                    // (set when planLatest is skipped, canceled, or in-progress)
  planPrevOk?:      RunStageEntry;  // most recent succeeded run
                                    // (set when planPrevActive is failed, or planLatest is failed)
  applyLatest?:     RunStageEntry;
  applyPrevActive?: RunStageEntry;
  applyPrevOk?:     RunStageEntry;
}
```

---

## Algorithm: `buildStageBranchSummaries`

### Run ordering

Runs **must be sorted by `id` descending** (newest first) before processing. The ADO API sorts by `finishTime DESC` by default, which misordering concurrent runs (a long-running older run that finishes last will appear first). Run IDs are assigned at queue time, so `id DESC` = queue-time newest-first.

```typescript
runs.sort((a, b) => b.id - a.id);
```

### Per-branch tracking

```
for each run (by id descending = newest first):
  branch = shortBranch(run.sourceBranch)
  for each stage in the timeline of that run:
    { kind, base } = parseStageKind(stage.name)
    key = kind === "other" ? "\x00" + base : base

    if key is new → init empty branchMap, append to baseOrder

    entry = { runId, result, state, finishTime, warningCount }

    isActive(r)  = r is defined and not "skipped"/"canceled"
    isPassive(r) = r === "skipped" || r === "canceled"

    for the branch in branchMap:
      if planLatest is empty:
        planLatest = entry
      else if planLatest is NOT active (skipped/canceled/in-progress/pending)
           and planPrevActive is not yet set
           and entry IS active (succeeded/failed):
        planPrevActive = entry
      else if planPrevOk is not yet set:
        effective = planPrevActive ?? planLatest
        if effective.result !== "succeeded" and entry.result === "succeeded":
          planPrevOk = entry
```

### `parseStageKind`

```
/^plan(.*)$/i              → kind="plan",  base = suffix stripped of leading _-/space
/^(?:apply|deploy)(.*)$/i  → kind="apply", base = suffix stripped of leading _-/space
name in planBases           → kind="plan",  base = full name   (convention 2)
otherwise                   → kind="other", base = full name
```

`planBases` is built in a pre-pass: stage names matching `Deploy <X>` or `Apply <X>` contribute their base `X` (lowercased). This allows bare names like `lrn` to be recognised as plan stages when `Deploy lrn` exists.

### `branchHasRun`

A branch row is shown when any of these is true:

```typescript
effective(planLatest)   // latest is non-skipped/non-canceled (includes failed, in-progress)
effective(applyLatest)
!!planPrevActive        // skipped latest but a prior active run exists
!!applyPrevActive
!!planPrevOk            // prev success exists
!!applyPrevOk
```

---

## `mostRecentBranch` logic

Per stage group, the most recently active branch is highlighted (bold branch text); other branches are dimmed (gray branch text). **Status cells are never dimmed** — they always use full color regardless of branch recency.

```typescript
const t = summary.applyLatest?.finishTime
       ?? summary.planLatest?.finishTime
       ?? summary.applyPrevOk?.finishTime
       ?? summary.planPrevOk?.finishTime
       ?? "";
if (!mostRecentBranch || t > mostRecentTime) { mostRecentBranch = branch; mostRecentTime = t; }
```

Key points:
- Skipped stages have **no `finishTime`**, so `t = ""` for branches where all runs are skipped.
- Use `!mostRecentBranch || t > mostRecentTime` (not just `t > mostRecentTime`) so the first valid branch is always set — otherwise `mostRecentBranch` stays `undefined` and all rows get `dim = true`.
- Fall back to `prevOk.finishTime` so branches with only skipped-recent/prev-success still get a time.

---

## Enter key behaviour

On a **branch row**, Enter opens the most relevant run in the browser:

```
latestRunId = applyLatest?.runId ?? planLatest?.runId
```

The most recent apply wins; if no apply ran, fall back to the most recent plan.  
On base group headers and separator rows, Enter does nothing.

---

## Caching

| Cache key                              | TTL      | Content                       |
|----------------------------------------|----------|-------------------------------|
| `runs_{org}_{project}_{pipelineId}`    | 2 min    | Pipeline runs (top 50), sorted by id desc |
| `stages_{org}_{project}_{runId}`       | 2 min    | Timeline stages per run       |
| `stages_{org}_{project}_{runId}`       | 60 min   | When all stages are completed |

Cache location: `~/.azure-pipelines-tui/cache/`

### Cache invalidation rules for `stages_*`

A cached entry is rejected and re-fetched when any of these hold:
1. There are completed stages (`succeeded`/`failed`) but none have a `finishTime` — old entry predates the `finishTime` field.
2. Any stage entry is missing `warningCount` (`=== undefined`) — old entry predates warning support.

---

## Pipeline definitions view

Accessed via `p` from the dashboard, or navigated to via `Esc` from the stages view.

### Tree structure

Pipelines are grouped into folders based on their ADO `path` field (e.g. `\Terraform\Landingzone`). Folders are rendered before pipelines within the same level; both are sorted alphabetically.

```
▼ Terraform
  ▼ Landingzone
    ├─ plan-lrn            174
    └─ deploy-lrn          175
  ▶ Networking
▼ Platform
    └─ infra               42
```

### Keys

| Key   | Action                                     |
|-------|--------------------------------------------|
| ↑↓    | Navigate                                   |
| Enter | Expand/collapse folder, or open stages     |
| →     | Expand collapsed folder                    |
| ←     | Collapse expanded folder / go to parent    |
| b     | Open pipeline summary in browser           |
| Esc   | Back to dashboard                          |

### Pre-selection

When navigating back from the stages dashboard (`Esc`), the pipeline definitions list scrolls to and selects the previously opened pipeline.

---

## CLI usage

```bash
# Open the stages dashboard directly for a pipeline (by ID or name)
npx tsx environments-dashboard.ts ORG/PROJECT --stages 42
npx tsx environments-dashboard.ts ORG/PROJECT --stages "Deploy-to-prod"
```

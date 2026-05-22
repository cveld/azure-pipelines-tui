# TUI Screens & Navigation

This document describes the unified TUI (`src/tui.ts`) — all screens, their purpose, and how users navigate between them.

---

## Screen inventory

| # | Screen | Description | Source file |
|---|--------|-------------|-------------|
| 1 | **Pipelines Overview** | Pipeline definitions tree, grouped by ADO folder path. Default landing screen. | `src/screens/PipelinesScreen.ts` |
| 2 | **Environments Overview** | Environments tree with latest deployment status (result, branch, age). | `src/screens/EnvironmentsScreen.ts` |
| 3 | **Stages Dashboard** | Per-pipeline: stages grouped by branch across recent runs, with Plan/Apply columns. | `src/screens/StagesScreen.ts` |
| 4 | **Pipeline Runs List** | Chronological list of all runs for a selected pipeline. | `src/screens/PipelineRunsScreen.ts` |
| 5 | **Pipeline Run** | Single-run detail: timeline tree (stages/jobs/steps) + live log panel (SignalR). | `src/screens/PipelineRunScreen.ts` |
| 6 | **Mapping Editor** | Side-by-side editor to link environments to pipelines. Sub-screen of Environments Overview. | `src/screens/MappingScreen.ts` |

---

## Navigation map

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   ┌──────────────────────┐    e/p    ┌──────────────────────┐           │
│   │  Pipelines Overview  │◄─────────►│ Environments Overview│           │
│   │     (default)        │           │                      │           │
│   └──────────┬───────────┘           └──────────┬───────────┘           │
│              │ Enter                            │ Enter (env w/ mapping) │
│              ▼                                  │                        │
│   ┌──────────────────────┐◄────────────────────┘                        │
│   │  Stages Dashboard    │                                               │
│   │                      │── p ──►  Pipelines Overview  (direct)        │
│   │                      │── e ──►  Environments Overview (direct)      │
│   │                      │── Esc ─► previous screen                     │
│   └──────────────────────┘                                               │
│              │ Enter (branch row)                                        │
│              ▼                                                           │
│   ┌──────────────────────┐            ┌──────────────────────┐          │
│   │  Pipelines Overview  │──── v ────►│  Pipeline Runs List  │          │
│   │                      │            │   Esc → back         │          │
│   │                      │──── o ──┐  └──────────┬───────────┘          │
│   └──────────────────────┘         │             │ Enter                │
│                                    │             ▼                      │
│                                    └───►┌──────────────────────┐        │
│                                         │    Pipeline Run       │        │
│                                         │  Esc tree → back     │        │
│                                         └──────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Navigation actions per screen

### Pipelines Overview (default)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Azure Pipelines TUI   ORG / PROJECT                                 │  ← header
├──────────────────────────────────────────────────────────────────────┤
│ Pipeline Definitions                                                 │
│                                                                      │
│  ▼ Terraform                                                         │
│    ▼ Landingzone                                                     │
│      ├─ plan-lrn                                              174    │
│      └─ deploy-lrn                                            175    │
│    ▶ Networking                                               (3)    │
│  ▶ Platform                                                   (5)    │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ ↑↓ Navigate  Enter Stages  v Runs  o Open  e Envs  b Browser        │
│ r Refresh  q Quit                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| ↑↓ | Navigate |
| Enter | Expand/collapse folder; open **Stages Dashboard** for selected pipeline |
| → | Expand collapsed folder |
| ← | Collapse expanded folder / navigate to parent |
| `v` | Open **Pipeline Runs List** for selected pipeline |
| `o` | Fetch the most recent run and open **Pipeline Run** directly |
| `e` | Switch to **Environments Overview** |
| `b` | Open pipeline summary in browser |
| `r` | Clear pipeline definitions cache and reload |
| `q` / Ctrl+C | Quit |

---

### Environments Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Azure Pipelines Environments   ORG / PROJECT                            │
├──────────────────────────────────────────────────────────────────────────┤
│  Environments        Pipeline            Status       Branch        Age  │
├──────────────────────────────────────────────────────────────────────────┤
│  ▼ accp                                                                  │
│    ├─ accp-app       deploy-app [cfg]    ✓ ok         main           5m  │
│    └─ accp-db        deploy-db [auto]   ✓ ok         main           1h  │
│  ▼ prod                                                                  │
│    └─ prod-app       deploy-app [cfg]   ✗ failed     feature/x     30m  │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Navigate  Enter Expand/Stages  ← Collapse  p Pipelines  m Mapping   │
│ r Refresh  c Clear  q Quit                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| ↑↓ | Navigate |
| Enter | On group: expand/collapse. On leaf **with** mapping: open **Stages Dashboard** for linked pipeline. On leaf **without** mapping: open latest build in browser |
| ← | Collapse expanded group / navigate to parent group |
| `p` | Switch to **Pipelines Overview** |
| `m` | Open **Mapping Editor** |
| `r` | Refresh (clears environment and deployment caches, reloads) |
| `c` | Clear all caches |
| `q` / Ctrl+C | Quit |

---

### Stages Dashboard

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Azure Pipelines   ORG / PROJECT   Stages: deploy-lrn                    │
├──────────────────────────────────────────────────────────────────────────┤
│  Stage / Branch                Plan                  Apply               │
├──────────────────────────────────────────────────────────────────────────┤
│ Stages: deploy-lrn  (48 runs)                                            │
│                                                                          │
│  Deploy                                                                  │
│    main                        ✓ 5m                  ✓ 2h               │
│    feature/PLAT-123            ✗ 30m (✓2d)           -                  │
│                                                                          │
│  Infra                                                                   │
│    main                        ✓ 1h                  ✗ 3h (✓1d)        │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Navigate  Enter Open run  r Refresh  b Browser  p Pipelines  e Envs  │
│ q Quit                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| ↑↓ | Navigate |
| Enter | On branch row: open **Pipeline Run** for the most relevant run (`applyLatest.runId ?? planLatest.runId`) |
| `p` | Navigate directly to **Pipelines Overview** |
| `e` | Navigate directly to **Environments Overview** |
| Esc | Go back to previous screen (Pipelines Overview or Environments Overview) |
| `b` | Open pipeline summary in browser |
| `r` | Refresh (clears runs and stages caches, reloads) |
| `q` / Ctrl+C | Quit |

---

### Pipeline Runs List

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Azure Pipelines   ORG / PROJECT   Runs: deploy-lrn                      │
├──────────────────────────────────────────────────────────────────────────┤
│ Runs: deploy-lrn  (24)                                                   │
│                                                                          │
│ #20481     main                           ✓ succeeded             5m     │
│ #20452     feature/PLAT-99                ✗ failed                1h     │
│ #20401     main                           ✓ succeeded             3h     │
│ #20350     release/v2                     ▶ running               5h     │
│ …                                                                        │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Navigate  Enter Open run  b Browser  r Refresh  Esc Back  q Quit     │
└──────────────────────────────────────────────────────────────────────────┘
```

Row format: `#buildNumber  branch(30)  result(30)  startTime`

| Key | Action |
|-----|--------|
| ↑↓ | Navigate |
| Enter | Open **Pipeline Run** for selected run |
| `b` | Open selected run in browser |
| `r` | Clear runs cache and reload |
| Esc | Go back (to **Pipelines Overview**) |
| `q` / Ctrl+C | Quit |

---

### Pipeline Run

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Azure Pipelines  ORG / PROJECT  #20481  ✓ succeeded                     │
├──────────────────┬───────────────────────────────────────────────────────┤
│ Pipeline         │ Logs — deploy job                                      │
│                  │                                                        │
│ ▼ Stage: Deploy  │ ── Checkout ──                                         │
│   ▼ Job: deploy  │ $ git checkout main                                    │
│     ✓ Checkout   │ HEAD is now at abc1234                                │
│     ▶ TF Init    │                                                        │
│     ○ TF Plan    │                                                        │
│ ⊘ 3 stages skip. │                                                        │
│                  │                                                        │
├──────────────────┴───────────────────────────────────────────────────────┤
│ ↑↓ Navigate  Enter/→ Select  ←/Esc Back  Tab Switch  f Follow  ● LIVE   │
│ r Retry stage  q Quit                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

| Key | Context | Action |
|-----|---------|--------|
| ↑↓ | tree | Navigate |
| Enter / → | tree | Expand/collapse node with children; select leaf task to show logs |
| ← | tree | Collapse node / navigate to parent |
| Esc | tree | Go back to previous screen |
| Tab | any | Switch focus: tree ↔ log panel |
| Esc / ← / Backspace | log panel | Return focus to tree |
| `f` / End | log panel | Enable follow mode (tail live logs) |
| `r` | tree, Stage selected | Retry/restart selected stage via PATCH stages API |
| `q` / Ctrl+C | any | Quit |

Header updates live as the build status changes. `● LIVE` indicator shows when follow mode is active.

---

### Mapping Editor

Sub-screen of **Environments Overview**. Opened via `m`. The left panel lists environments; the right panel lists all pipeline definitions.

| Key | Action |
|-----|--------|
| Tab | Switch focus between left (Environments) and right (Pipelines) panel |
| Space / Enter | Link selected environment to selected pipeline |
| `d` | Delete mapping for selected environment |
| `s` | Save config to `environments-config.json` and return to **Environments Overview** |
| Esc | Discard all unsaved changes and return to **Environments Overview** |

---

## Entry points (CLI)

| Command | Opens |
|---------|-------|
| `npx tsx src/tui.ts ORG/PROJECT` | Pipelines Overview |
| `npx tsx src/tui.ts ORG/PROJECT --envs` | Environments Overview |
| `npx tsx src/tui.ts ORG/PROJECT --stages <pipelineId\|name>` | Stages Dashboard |
| `npx tsx src/tui.ts ORG/PROJECT --runs <pipelineId\|name>` | Pipeline Runs List |
| `npx tsx src/tui.ts https://dev.azure.com/ORG/PROJECT/_build/results?buildId=N` | Pipeline Run |
| `npx tsx src/tui.ts ORG/PROJECT N` | Pipeline Run (build ID N) |

All forms also accept `--config <file>` to override the config file (default: `environments-config.json`) and `--keep-timestamps` to retain timestamps in log output.

---

## Back-navigation

Navigation uses a single-level history: `previousDest` records where you came from. `goBack()` returns to `previousDest`, defaulting to Pipelines Overview.

| Screen | Esc / `goBack()` goes to |
|--------|--------------------------|
| Stages Dashboard (Esc) | previous screen (Pipelines or Environments) |
| Pipeline Runs List (Esc) | previous screen (Pipelines Overview) |
| Pipeline Run (Esc on tree) | previous screen (Runs List, Stages, or Pipelines) |
| Mapping Editor (Esc) | Environments Overview (hard-coded) |

`p` and `e` keys in Stages Dashboard navigate directly (bypassing `goBack()`).

---

## Code structure

```
src/
  tui.ts                       Entry point: CLI, screen factory, navigation router
  lib/
    types.ts                   All domain interfaces and types
    api.ts                     getToken, HTTP helpers, all ADO API fetch functions
    format.ts                  Formatting helpers, tree builders, stage/run helpers
  screens/
    context.ts                 AppContext, View, NavDestination types
    PipelinesScreen.ts         Screen 1
    EnvironmentsScreen.ts      Screen 2
    StagesScreen.ts            Screen 3
    PipelineRunsScreen.ts      Screen 4
    PipelineRunScreen.ts       Screen 5 (SignalR + REST polling)
    MappingScreen.ts           Screen 6
```

Each screen class exposes:
- `show(params?)` — show widgets, focus, start async loading
- `hide()` — hide widgets; `PipelineRunScreen.hide()` also stops the poll loop
- `footerText` getter — returns the key-hints string rendered in the footer bar

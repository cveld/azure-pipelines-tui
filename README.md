# Azure Pipelines TUI

A terminal UI for Azure DevOps pipelines. Two standout features:

### Live pipeline run viewer

Follow a running or completed pipeline build in real time. A stage/job tree on the left streams log output on the right via SignalR — no browser required.

```
┌ Pipeline ──────────────┐┌ Logs — Initialize job ───────────────────────────────┐
│ v + build              ││ ##[section]Starting: Initialize job                  │
│   > + Initialize job   ││ Agent name: 'myorg-pool-agent-abc123'                │
│   > > Terraform plan   ││ Agent machine name: 'myorg-pool-agent-abc123'        │
│   . Terraform apply    ││ Current agent version: '4.273.0'                     │
│ ~ 14 stages skipped    ││ Agent running as: 'agentuser'                        │
└────────────────────────┘└──────────────────────────────────────────────────────┘
```

### Stages dashboard for GitOps

Per-branch overview of Plan/Apply stage pairs across recent runs. Shows the current deployment state for every branch at a glance — and when a run failed, also shows the last successful result alongside it.

```
  Stage / Branch                Plan                  Apply
┌ Stages: Deploy-to-prod (48 runs) ────────────────────────────────────────────┐
│  Deploy                                                                       │
│    main                        ✓ 5m                  ✓ 2h                    │
│    feature/PLAT-123            ✗ 30m (✓2d)           -                       │
│    release/v1.2                ✓ 1h                  ✓ 3h                    │
│                                                                               │
│  Infra                                                                        │
│    main                        ✓ 1h                  ✗ 3h (✓1d)             │
│    feature/PLAT-456            ○ wait                -                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Requirements

- Node.js 18+
- Azure CLI (`az`) signed in to the correct tenant

## Usage

```bash
npx azure-pipelines-tui ORG/PROJECT                   # Pipelines overview (default)
npx azure-pipelines-tui ORG/PROJECT --envs            # Environments overview
npx azure-pipelines-tui ORG/PROJECT --stages <id>     # Stages dashboard
npx azure-pipelines-tui ORG/PROJECT --runs <id>       # Pipeline runs list
npx azure-pipelines-tui ORG/PROJECT <buildId>         # Single pipeline run
npx azure-pipelines-tui <build-url>                   # Single pipeline run (full URL)
```

### Key bindings

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate tree / scroll logs |
| `Enter` `→` | Expand / select step |
| `←` `Esc` | Collapse / back |
| `Tab` | Switch focus between panels |
| `f` `End` | Follow mode — tail the log |
| `r` | Retry/restart selected stage |
| `q` `Ctrl+C` | Quit |

## Stages dashboard

Status icons:

| Icon | Meaning |
|------|---------|
| `✓ 5m` | Succeeded, finished 5 minutes ago |
| `✗ 30m (✓2d)` | Failed, last success was 2 days ago |
| `▶ –` | In progress |
| `⚠ 5m` | Succeeded with warnings |
| `⊘ –` | Skipped / canceled, no prior run |
| `○ –` | Pending |
| `-` | Stage did not run |

The `*` suffix (e.g. `✓ 2d *`) means the most recent run was skipped or canceled — the cell shows the last active run instead.

### Key bindings

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate rows |
| `Enter` | Open the run in the browser |
| `r` | Refresh data |
| `b` | Open pipeline summary in browser |
| `p` | Go to pipelines list |
| `e` | Go to environments overview |
| `Esc` | Back |
| `q` | Quit |

See [docs/stages-dashboard-design.md](docs/stages-dashboard-design.md) for the full design.

## How to run locally

```bash
npm install
npm run start -- ORG/PROJECT
npm run start -- ORG/PROJECT --envs
npm run start -- ORG/PROJECT --stages <id>
npm run start -- ORG/PROJECT --runs <id>
npm run start -- ORG/PROJECT <buildId>
npm run start -- <build-url>
```

## How it works

The TUI combines two data sources:

1. **REST polling** (every 500 ms) — fetches build status, timeline records, and log lines via the Azure DevOps REST API.
2. **SignalR** (ASP.NET SignalR 1.x over WebSocket) — receives live events as log lines are written.

See [docs/signalr-design.md](docs/signalr-design.md) for the full SignalR protocol details.

## Note

The SignalR streaming API is undocumented. We reverse-engineered it by downloading and analysing the Azure DevOps web app bundles with Claude.

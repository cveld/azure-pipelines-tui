# Azure Pipelines TUI

A terminal UI for live-following Azure DevOps pipeline runs, with streaming logs via SignalR.

```
┌ Pipeline ──────────────┐┌ Logs — Initialize job ───────────────────────────────┐
│ v + build              ││ ##[section]Starting: Initialize job                  │
│   > + Initialize job   ││ Agent name: 'myorg-pool-agent-abc123'                │
│   > > Terraform plan   ││ Agent machine name: 'myorg-pool-agent-abc123'        │
│   . Terraform apply    ││ Current agent version: '4.273.0'                     │
│ ~ 14 stages skipped    ││ Agent running as: 'agentuser'                        │
└────────────────────────┘└──────────────────────────────────────────────────────┘
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

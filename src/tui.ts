#!/usr/bin/env node
// tui.ts — Unified Azure Pipelines TUI entry point

import os from "os";
import { URL } from "url";
import * as blessed from "blessed";
import { loadConfig, getToken, fetchPipelineDefinitions } from "./lib/api.js";
import type { DashboardConfig } from "./lib/types.js";
import type { NavDestination, View, AppContext, AppState } from "./screens/context.js";
import { PipelinesScreen }     from "./screens/PipelinesScreen.js";
import { EnvironmentsScreen }  from "./screens/EnvironmentsScreen.js";
import { StagesScreen }        from "./screens/StagesScreen.js";
import { PipelineRunsScreen }  from "./screens/PipelineRunsScreen.js";
import { PipelineRunScreen }   from "./screens/PipelineRunScreen.js";
import { MappingScreen }       from "./screens/MappingScreen.js";
import { OrgsScreen }          from "./screens/OrgsScreen.js";
import { ProjectsScreen }      from "./screens/ProjectsScreen.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

function showHelp(): never {
  console.log(`
Azure Pipelines TUI

Usage:
  npx azure-pipelines-tui ORG/PROJECT                  Pipelines Overview (default)
  npx azure-pipelines-tui ORG/PROJECT --envs            Environments Overview
  npx azure-pipelines-tui ORG/PROJECT --stages <id>     Stages Dashboard
  npx azure-pipelines-tui ORG/PROJECT --runs <id>       Pipeline Runs List
  npx azure-pipelines-tui <build-url>                   Pipeline Run (single build)
  npx azure-pipelines-tui ORG/PROJECT <buildId>         Pipeline Run (single build)

Options:
  --config <file>       Config file (default: environments-config.json)
  --stages <id>         Pipeline ID or name to open stages view directly
  --runs <id>           Pipeline ID or name to open runs list directly
  --envs                Open environments overview
  --keep-timestamps     Keep timestamps in log output
  --help                Show this help

Cache location: ${os.homedir()}/.azure-pipelines-tui/cache/
`);
  process.exit(0);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help")) showHelp();

const flagsWithValues = new Set(["--config", "--stages", "--runs"]);
const positional: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a.startsWith("--")) { if (flagsWithValues.has(a)) i++; continue; }
  positional.push(a);
}

const configIdx  = rawArgs.indexOf("--config");
const CONFIG_FILE = configIdx >= 0 ? rawArgs[configIdx + 1] : "environments-config.json";
const stagesIdx  = rawArgs.indexOf("--stages");
const STAGES_ARG = stagesIdx >= 0 ? rawArgs[stagesIdx + 1] : undefined;
const runsIdx    = rawArgs.indexOf("--runs");
const RUNS_ARG   = runsIdx >= 0 ? rawArgs[runsIdx + 1] : undefined;
const ENVS_FLAG  = rawArgs.includes("--envs");
const KEEP_TIMESTAMPS = rawArgs.includes("--keep-timestamps");

function parseAdoUrl(raw: string): { org: string; project: string; buildId?: string } | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "dev.azure.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { org: parts[0], project: parts[1], buildId: u.searchParams.get("buildId") ?? undefined };
  } catch { return null; }
}

let ORG = "";
let PROJECT = "";
let INITIAL_BUILD_ID: string | undefined;
let INITIAL_VIEW: View = "pipelines";

const parsed = positional.length >= 1 ? parseAdoUrl(positional[0]) : null;
if (parsed) {
  ORG = parsed.org; PROJECT = parsed.project;
  INITIAL_BUILD_ID = parsed.buildId ?? (positional.length >= 2 ? positional[1] : undefined);
} else if (positional.length >= 3) {
  [ORG, PROJECT, INITIAL_BUILD_ID] = positional;
} else if (positional.length >= 1 && positional[0].includes("/")) {
  const [org, ...rest] = positional[0].split("/");
  ORG = org; PROJECT = rest.join("/");
  if (positional.length >= 2) INITIAL_BUILD_ID = positional[1];
} else if (positional.length >= 2) {
  [ORG, PROJECT] = positional;
}

if (INITIAL_BUILD_ID)     INITIAL_VIEW = "pipelineRun";
else if (STAGES_ARG)      INITIAL_VIEW = "stages";
else if (RUNS_ARG)        INITIAL_VIEW = "runs";
else if (ENVS_FLAG)       INITIAL_VIEW = "environments";
else if (!ORG)            INITIAL_VIEW = "orgs";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig(CONFIG_FILE) as DashboardConfig;
  if (!ORG) ORG = config.org ?? "";
  if (!PROJECT) PROJECT = config.project ?? "";
  if ((!ORG || !PROJECT) && INITIAL_VIEW !== "orgs") {
    console.error(
      "Error: org/project required. Pass as 'org/project' argument or set in environments-config.json.\n" +
      "Run with --help for usage."
    );
    process.exit(1);
  }
  if (ORG) config.org = ORG;
  if (PROJECT) config.project = PROJECT;

  // ── Shared state ──────────────────────────────────────────────────────────
  const state: AppState = { pipelines: [] };

  // ── Screen + widgets ──────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: true, title: "Azure Pipelines TUI",
    fullUnicode: true, forceUnicode: true,
  });
  process.stdout.write("\x1b[?25l");
  const restoreCursor = () => process.stdout.write("\x1b[?25h");
  screen.on("destroy", restoreCursor);
  process.on("exit", restoreCursor);
  process.on("SIGINT", () => { restoreCursor(); process.exit(0); });

  const headerBox = blessed.box({
    parent: screen, top: 0, left: 0, width: "100%", height: 1, tags: true,
    style: { bg: "blue", fg: "white", bold: true },
    content: ` {bold}Azure Pipelines TUI{/bold}`,
  });

  const footerBox = blessed.box({
    parent: screen, bottom: 0, left: 0, width: "100%", height: 1, tags: true,
    style: { bg: "black", fg: "gray" },
  });

  // ── Status bar ─────────────────────────────────────────────────────────────
  let statusMsg = "";
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(msg: string, ttlMs = 3000) {
    statusMsg = msg;
    if (statusTimer) clearTimeout(statusTimer);
    if (ttlMs > 0 && msg) statusTimer = setTimeout(() => { statusMsg = ""; renderFooter(); }, ttlMs);
    renderFooter();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  let currentView: View = INITIAL_VIEW;
  let previousDest: NavDestination = { view: "pipelines" };
  let currentDest: NavDestination = { view: "pipelines" };

  function updateHeader() {
    let content: string;
    if (currentView === "orgs") {
      content = ` {bold}Azure Pipelines TUI{/bold}  Select organization`;
    } else if (currentView === "projects") {
      content = ` {bold}Azure Pipelines TUI{/bold}  ${ORG}  — Select project`;
    } else if (currentView === "pipelineRun") {
      const run = screens.pipelineRun;
      const build = run.getBuild();
      const id = run.getBuildId();
      const statusTag = !build
        ? "{yellow-fg}loading…{/}"
        : build.status === "completed"
          ? build.result === "succeeded"   ? "{green-fg}succeeded{/}"
          : build.result === "failed"      ? "{red-fg}failed{/}"
          : build.result === "canceled"    ? "{gray-fg}canceled{/}"
          : (build.result ?? "completed")
        : build.status === "inProgress"   ? "{yellow-fg}▶ running{/}"
        : build.status === "notStarted"   ? "{gray-fg}waiting…{/}"
        : build.status;
      content = ` {bold}Azure Pipelines{/bold}  ${ORG} / ${PROJECT}  #{bold}${id}{/bold}  ${statusTag}`;
    } else if (currentView === "stages") {
      const pip = screens.stages.getPipeline();
      content = ` {bold}Azure Pipelines{/bold}  ${ORG} / ${PROJECT}  Stages: ${pip?.name ?? ""}`;
    } else if (currentView === "runs") {
      const pip = screens.runs.getPipeline();
      content = ` {bold}Azure Pipelines{/bold}  ${ORG} / ${PROJECT}  Runs: ${pip?.name ?? ""}`;
    } else if (currentView === "environments") {
      content = ` {bold}Azure Pipelines Environments{/bold}  ${ORG} / ${PROJECT}`;
    } else {
      content = ` {bold}Azure Pipelines TUI{/bold}  ${ORG} / ${PROJECT}`;
    }
    headerBox.setContent(content);
    screen.render();
  }

  function renderFooter() {
    const s = statusMsg ? `  {yellow-fg}${statusMsg}{/}` : "";
    const screenObj = screens[currentView];
    const base = screenObj.footerText ?? "";
    footerBox.setContent(base + s);
    screen.render();
  }

  function hideAll() {
    for (const s of Object.values(screens)) s.hide();
  }

  function navigate(dest: NavDestination) {
    previousDest = currentDest;
    currentDest = dest;
    currentView = dest.view;
    hideAll();
    switch (dest.view) {
      case "orgs":         screens.orgs.show(); break;
      case "projects":     screens.projects.show(dest.org); break;
      case "pipelines":    screens.pipelines.show(); break;
      case "environments": screens.environments.show(); break;
      case "mapping":      screens.mapping.show(); break;
      case "stages":       screens.stages.show(dest.pipeline); break;
      case "runs":         screens.runs.show(dest.pipeline); break;
      case "pipelineRun":  screens.pipelineRun.show(dest.buildId); break;
    }
    updateHeader();
    renderFooter();
  }

  function goBack() {
    navigate(previousDest);
  }

  // ── App context ────────────────────────────────────────────────────────────
  const ctx: AppContext = {
    get org() { return ORG; },
    get project() { return PROJECT; },
    config,
    state,
    getToken: () => getToken(config.azConfigDir),
    navigate,
    goBack,
    setStatus,
    setOrgProject(org: string, project: string) {
      ORG = org; PROJECT = project;
      config.org = org; config.project = project;
      state.pipelines = [];
    },
    loadPipelineDefinitions: async () => {
      if (state.pipelines.length > 0) return;
      setStatus("Loading pipeline definitions…", 0);
      try {
        const token = await getToken(config.azConfigDir);
        state.pipelines = await fetchPipelineDefinitions(ORG, PROJECT, token);
        setStatus("", 0);
      } catch (e) {
        setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
      }
    },
  };

  // ── Create screens ─────────────────────────────────────────────────────────
  const envScreen  = new EnvironmentsScreen(screen, ctx);
  const screens = {
    orgs:         new OrgsScreen(screen, ctx),
    projects:     new ProjectsScreen(screen, ctx),
    pipelines:    new PipelinesScreen(screen, ctx),
    environments: envScreen,
    stages:       new StagesScreen(screen, ctx),
    runs:         new PipelineRunsScreen(screen, ctx),
    pipelineRun:  new PipelineRunScreen(screen, ctx, { keepTimestamps: KEEP_TIMESTAMPS }),
    mapping:      new MappingScreen(screen, ctx, envScreen, CONFIG_FILE),
  };

  // ── Global keys ────────────────────────────────────────────────────────────
  screen.key(["q", "C-c"], () => { screen.destroy(); process.exit(0); });
  screen.key("tab", () => {
    if (currentView === "pipelineRun") {
      const { treeWidget, logWidget } = screens.pipelineRun;
      if (screen.focused === treeWidget) logWidget.focus();
      else treeWidget.focus();
      screen.render();
    }
  });

  // ── Initial navigation ────────────────────────────────────────────────────
  if (INITIAL_VIEW === "orgs") {
    navigate({ view: "orgs" });
  } else if (INITIAL_VIEW === "pipelineRun" && INITIAL_BUILD_ID) {
    navigate({ view: "pipelineRun", buildId: INITIAL_BUILD_ID });
  } else if (INITIAL_VIEW === "stages" && STAGES_ARG) {
    navigate({ view: "pipelines" });
    setStatus("Loading pipeline definitions…", 0);
    ctx.loadPipelineDefinitions().then(() => {
      const byId = Number(STAGES_ARG);
      const pip  = byId
        ? state.pipelines.find(p => p.id === byId)
        : state.pipelines.find(p => p.name.toLowerCase() === STAGES_ARG.toLowerCase());
      if (!pip) setStatus(`Pipeline "${STAGES_ARG}" not found`, 10_000);
      else navigate({ view: "stages", pipeline: pip });
    });
  } else if (INITIAL_VIEW === "runs" && RUNS_ARG) {
    navigate({ view: "pipelines" });
    setStatus("Loading pipeline definitions…", 0);
    ctx.loadPipelineDefinitions().then(() => {
      const byId = Number(RUNS_ARG);
      const pip  = byId
        ? state.pipelines.find(p => p.id === byId)
        : state.pipelines.find(p => p.name.toLowerCase() === RUNS_ARG.toLowerCase());
      if (!pip) setStatus(`Pipeline "${RUNS_ARG}" not found`, 10_000);
      else navigate({ view: "runs", pipeline: pip });
    });
  } else if (INITIAL_VIEW === "environments") {
    navigate({ view: "environments" });
  } else {
    navigate({ view: "pipelines" });
  }

}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

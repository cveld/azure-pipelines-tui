import type { DashboardConfig, PipelineDefinition } from "../lib/types.js";

export type View = "pipelines" | "environments" | "stages" | "runs" | "pipelineRun" | "mapping";

export type NavDestination =
  | { view: "pipelines" }
  | { view: "environments" }
  | { view: "stages"; pipeline: PipelineDefinition }
  | { view: "runs"; pipeline: PipelineDefinition }
  | { view: "pipelineRun"; buildId: string }
  | { view: "mapping" };

export interface AppState {
  pipelines: PipelineDefinition[];
}

export interface AppContext {
  readonly org: string;
  readonly project: string;
  readonly config: DashboardConfig;
  readonly state: AppState;
  getToken(): Promise<string>;
  navigate(dest: NavDestination): void;
  goBack(): void;
  setStatus(msg: string, ttlMs?: number): void;
  loadPipelineDefinitions(): Promise<void>;
}

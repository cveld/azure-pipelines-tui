// Domain types shared across screens

export interface AdoOrg { accountId: string; accountName: string; }
export interface AdoProject { id: string; name: string; description?: string; state: string; }

export interface AzTokenResponse { accessToken: string; expiresOn: string; }
export interface AdoEnvironment { id: number; name: string; description?: string; }
export interface DeploymentRecord {
  id: number;
  definition: { id: number; name: string };
  owner: { id: number | string; name: string };
  result: string;
  startTime?: string;
  finishTime?: string;
}
export interface BuildInfo {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  sourceBranch?: string;
  startTime?: string;
  finishTime?: string;
}
export interface PipelineDefinition { id: number; name: string; path: string; }
export interface EnvMapping {
  environmentId: number;
  environmentName: string;
  pipelineId: number;
  pipelineName: string;
}
export interface DashboardConfig {
  org?: string;
  project?: string;
  azConfigDir?: string;
  mappings: EnvMapping[];
}
export interface EnvRow {
  env: AdoEnvironment;
  deploy?: DeploymentRecord;
  build?: BuildInfo;
  mapping?: EnvMapping;
  loading: boolean;
}
export interface PipelineRun {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
}
export interface StageInfo {
  id: string;
  name: string;
  state: string;
  result?: string;
  order?: number;
  finishTime?: string;
  warningCount?: number;
}
export interface RunStageEntry {
  runId: number;
  result?: string;
  state: string;
  finishTime?: string;
  warningCount?: number;
}
export interface StageBranchSummary {
  branch: string;
  planLatest?: RunStageEntry;
  planPrevActive?: RunStageEntry;
  planPrevOk?: RunStageEntry;
  applyLatest?: RunStageEntry;
  applyPrevActive?: RunStageEntry;
  applyPrevOk?: RunStageEntry;
}
export type StageMeta =
  | { kind: "base"; displayName: string }
  | { kind: "branch"; branch: string; latestRunId?: number }
  | { kind: "separator" };

// Single-build run types
export type BuildStatus = "notStarted" | "inProgress" | "completed" | "cancelling" | "postponed";
export type BuildResult = "succeeded" | "failed" | "canceled" | "partiallySucceeded";
export interface Build {
  status: BuildStatus;
  result: BuildResult | null;
  startTime?: string;
  finishTime?: string;
  plans?: Array<{ planId: string }>;
}
export interface LogRef { id: number; url: string; }
export interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  identifier?: string;
  state: "pending" | "inProgress" | "completed";
  result?: string;
  order?: number;
  log?: LogRef;
}
export interface Timeline { records: TimelineRecord[]; }
export interface LogContent { value: string[]; count: number; }
export interface RegularItem {
  kind: "regular";
  record: TimelineRecord;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}
export interface GroupItem {
  kind: "group";
  id: string;
  depth: number;
  count: number;
  label: string;
  isExpanded: boolean;
}
export type FlatRunItem = RegularItem | GroupItem;

// Environment / pipeline tree types
export interface EnvTreeNode {
  key: string;
  label: string;
  children: Map<string, EnvTreeNode>;
  row?: EnvRow;
}
export type FlatEnvItem =
  | { kind: "group"; key: string; label: string; depth: number; isExpanded: boolean; total: number; ok: number; fail: number; ownRow?: EnvRow }
  | { kind: "leaf";  key: string; label: string; depth: number; row: EnvRow; isLast: boolean };
export interface PipeTreeNode {
  key: string;
  label: string;
  children: Map<string, PipeTreeNode>;
  pipeline?: PipelineDefinition;
}
export type FlatPipeItem =
  | { kind: "folder";   key: string; label: string; depth: number; isExpanded: boolean; count: number }
  | { kind: "pipeline"; key: string; label: string; depth: number; pipeline: PipelineDefinition; isLast: boolean };

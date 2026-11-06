import { Schema } from 'effect';

export const AccomplishmentSchema = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  state: Schema.Literals(['completed', 'ongoing', 'discussed']),
  evidenceIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
export const AgentResultSchema = Schema.Struct({
  accomplishments: Schema.Array(AccomplishmentSchema),
});
export type AgentResult = typeof AgentResultSchema.Type;
function agentJsonSchema(schema: Schema.Constraint) {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' });
  if (typeof document.schema !== 'object')
    throw new Error('Agent output requires an object schema.');
  // Omit $schema: Claude's validator does not load draft2020-12 meta-schemas.
  return {
    ...document.schema,
    ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
  };
}
export const outputJsonSchema = agentJsonSchema(AgentResultSchema);
export const ReportDraftSchema = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
  evidenceIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type ReportDraft = typeof ReportDraftSchema.Type;
export const reportJsonSchema = agentJsonSchema(ReportDraftSchema);
export interface ReportMaterial {
  evidence: Evidence[];
  accomplishments: Array<AgentResult['accomplishments'][number] & { day: string }>;
  warnings: string[];
}
export interface Workspace {
  id: string;
  label?: string;
  workRoot: string | null;
  gitlabUrl: string | null;
  timezone: string;
  lastUsedAt: string;
}
export interface ReportView {
  scope: string;
  id: string;
  kind: 'daily' | 'weekly';
  fromDay: string;
  toDay: string;
  draft: string;
  edited: string | null;
  draftVersion: number;
  editVersion: number;
  editedFromVersion: number | null;
  generatedAt: string;
  editedAt: string | null;
  evidenceIds: string[];
  warnings: string[];
  inputHash: string;
  sourceRevision: string;
  agent: string;
  fallback: string | null;
}
export interface ReportResponse {
  report: ReportView | null;
  archived: boolean;
  stale: boolean;
  evidence: Evidence[];
  jobs: Job[];
}
export interface Project {
  path: string;
  checkout: string;
  id?: string;
  members?: string[];
  authorEmails?: string[];
}
export interface RepositoryCheckout {
  path: string;
  checkout: string;
  commonDir?: string;
  gitDir?: string;
  authorEmail?: string;
  error?: string;
}
export interface RepositoryGroup extends Project {
  id: string;
  members: string[];
  authorEmails: string[];
  checkouts: RepositoryCheckout[];
  commonDir?: string;
}
export interface ProjectCatalog {
  workspaceId: string;
  root: string;
  groups: RepositoryGroup[];
  selection: string[] | null;
  includeSharedSessions: boolean;
}
export interface Evidence {
  id: string;
  project: string;
  time: string;
  action: string;
  title: string;
  url: string;
  excerpt?: string;
  canonicalId?: string;
  localGit?: { checkout: string; commit: string; authorEmail: string; inspected?: boolean };
  push?: { from: string | null; to: string; count: number | null; ref: string | null };
  session?: {
    provider: 'codex' | 'claude';
    id: string;
    file: string;
    entry: string;
    workRoot: string;
  };
  targetType: string | null;
  targetIid: number | null;
}
export interface Audit {
  covered: string[];
  evidence: Evidence[];
  sourceError?: string;
  failedSources?: string[];
  warnings?: string[];
}
export interface Job {
  id: string;
  day: string;
  status: string;
  agent: string | null;
  fallback: string | null;
  error: string | null;
  createdAt: string;
  kind: string;
  attempts: number;
  nextRunAt: string | null;
  payload: string;
}
export interface EvidencePage {
  items: Evidence[];
  total: number;
  offset: number;
  hasMore: boolean;
}
export interface DailyView {
  evidence: Evidence[];
  supportingEvidence: Evidence[];
  hasMore: boolean;
  accomplishments: Array<AgentResult['accomplishments'][number] & { id: number }>;
  jobs: Job[];
}
export interface AppStatus {
  configured: boolean;
  remoteCollection: boolean;
  workspaceId: string;
  workspaces: Workspace[];
  configPath: string;
  workRoot: string | null;
  gitlabUrl: string | null;
  timezone: string;
  setupError: string | null;
  automatic: boolean;
  collectionStartDate: string;
  activeJob: Job | null;
  queuedJobs: number;
  lastCollectedAt: string | null;
  nextAutomaticAt: string | null;
  workerError: string | null;
}

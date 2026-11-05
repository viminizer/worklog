import { Schema } from 'effect';
import { z } from 'zod';

export const AccomplishmentSchema = Schema.Struct({
  title: Schema.String,
  state: Schema.Literals(['completed', 'ongoing', 'discussed']),
  evidenceIds: Schema.Array(Schema.String),
});
export const AgentResultSchema = Schema.Struct({
  accomplishments: Schema.Array(AccomplishmentSchema),
});
export type AgentResult = typeof AgentResultSchema.Type;
export const outputJsonSchema = z.toJSONSchema(
  z.object({
    accomplishments: z.array(
      z.object({
        title: z.string().min(1).max(1000),
        state: z.enum(['completed', 'ongoing', 'discussed']),
        evidenceIds: z.array(z.string()).min(1),
      }),
    ),
  }),
);
// Claude's schema validator does not load draft2020-12 meta-schemas. The
// structural contract uses the shared subset and needs no $schema declaration.
delete outputJsonSchema.$schema;

export interface Project {
  path: string;
  checkout: string;
}
export interface Evidence {
  id: string;
  project: string;
  time: string;
  action: string;
  title: string;
  url: string;
  excerpt?: string;
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
}
export interface Job {
  id: string;
  day: string;
  status: string;
  agent: string | null;
  fallback: string | null;
  error: string | null;
  createdAt: string;
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
  configPath: string;
  workRoot: string | null;
  gitlabUrl: string | null;
  timezone: string;
  setupError: string | null;
}

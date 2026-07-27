import type { Workflow } from '../graph/types';
import type { RunTrace } from '../runtime/events';

export type VersionStatus = 'draft' | 'published' | 'archived';

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Version number currently open for editing. */
  draftVersion: number;
  /** Version number serving live traffic, if any. */
  publishedVersion?: number;
}

export interface WorkflowVersion {
  workflowId: string;
  version: number;
  status: VersionStatus;
  /** Immutable snapshot of the graph at this version. */
  graph: Workflow;
  changelog?: string;
  createdAt: string;
  createdBy: string;
}

export type DeploymentKind =
  'rest' | 'webhook' | 'schedule' | 'worker' | 'chat' | 'cli' | 'widget';

export interface Deployment {
  id: string;
  workflowId: string;
  version: number;
  kind: DeploymentKind;
  /** URL-safe identifier used in the public endpoint path. */
  slug: string;
  enabled: boolean;
  /** Hashed bearer token. The plaintext is shown exactly once, at creation. */
  tokenHash?: string;
  cron?: string;
  rateLimitPerMinute: number;
  createdAt: string;
  lastInvokedAt?: string;
  invocations: number;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  version?: number;
  trace: RunTrace;
  createdAt: string;
}

export interface EvalCase {
  id: string;
  input: unknown;
  expected?: unknown;
  /** Free-form labels for slicing results, e.g. `{ difficulty: 'hard' }`. */
  tags?: Record<string, string>;
}

export interface EvalSuite {
  id: string;
  workflowId: string;
  name: string;
  description?: string;
  cases: EvalCase[];
  /** Metric ids from the metric registry, plus any custom ones. */
  metrics: string[];
  createdAt: string;
}

export interface EvalCaseResult {
  caseId: string;
  runId: string;
  status: 'passed' | 'failed' | 'errored';
  scores: Record<string, number>;
  output: unknown;
  durationMs: number;
  costUsd: number;
  totalTokens: number;
  error?: string;
}

export interface EvalRun {
  id: string;
  suiteId: string;
  workflowId: string;
  version: number;
  label?: string;
  startedAt: string;
  finishedAt?: string;
  results: EvalCaseResult[];
  /** Mean of each metric across all cases. */
  summary: Record<string, number>;
  passRate: number;
  totalCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface MarketplaceTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  version: string;
  downloads: number;
  rating: number;
  ratingCount: number;
  featured: boolean;
  graph: Workflow;
  readme?: string;
  updatedAt: string;
}

export interface CredentialRecord {
  key: string;
  label: string;
  /** AES-256-GCM ciphertext. Plaintext never leaves the vault. */
  ciphertext: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ListRunsQuery {
  workflowId?: string;
  status?: RunTrace['status'];
  limit?: number;
  since?: string;
}

/**
 * Persistence contract.
 *
 * Every backend implements this: the default file store, the in-memory store used
 * by tests, and the Postgres adapter. Nothing above this layer knows which is
 * in use.
 */
export interface Store {
  listWorkflows(ownerId?: string): Promise<WorkflowRecord[]>;
  getWorkflow(id: string): Promise<WorkflowRecord | undefined>;
  createWorkflow(record: WorkflowRecord, graph: Workflow): Promise<WorkflowRecord>;
  updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<WorkflowRecord>;
  deleteWorkflow(id: string): Promise<void>;

  listVersions(workflowId: string): Promise<WorkflowVersion[]>;
  getVersion(workflowId: string, version: number): Promise<WorkflowVersion | undefined>;
  /** Overwrites the open draft in place. */
  saveDraft(workflowId: string, graph: Workflow): Promise<WorkflowVersion>;
  /** Freezes the draft, marks it published, and opens a fresh draft. */
  publish(workflowId: string, changelog?: string): Promise<WorkflowVersion>;
  /** Copies an old version's graph into the draft. */
  rollback(workflowId: string, toVersion: number): Promise<WorkflowVersion>;
  /** The graph to execute: published if one exists, otherwise the draft. */
  resolveGraph(workflowId: string, version?: number): Promise<Workflow | undefined>;

  saveRun(record: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(query?: ListRunsQuery): Promise<RunRecord[]>;

  listDeployments(workflowId?: string): Promise<Deployment[]>;
  getDeploymentBySlug(slug: string): Promise<Deployment | undefined>;
  saveDeployment(deployment: Deployment): Promise<void>;
  deleteDeployment(id: string): Promise<void>;

  listSuites(workflowId?: string): Promise<EvalSuite[]>;
  getSuite(id: string): Promise<EvalSuite | undefined>;
  saveSuite(suite: EvalSuite): Promise<void>;
  listEvalRuns(suiteId?: string): Promise<EvalRun[]>;
  saveEvalRun(run: EvalRun): Promise<void>;

  listTemplates(): Promise<MarketplaceTemplate[]>;
  getTemplate(id: string): Promise<MarketplaceTemplate | undefined>;
  saveTemplate(template: MarketplaceTemplate): Promise<void>;

  listCredentials(): Promise<CredentialRecord[]>;
  saveCredential(record: CredentialRecord): Promise<void>;
  deleteCredential(key: string): Promise<void>;
}

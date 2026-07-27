import type { Workflow } from '../graph/types';
import type {
  CredentialRecord,
  Deployment,
  EvalRun,
  EvalSuite,
  ListRunsQuery,
  MarketplaceTemplate,
  RunRecord,
  Store,
  WorkflowRecord,
  WorkflowVersion,
} from './types';

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} "${id}" not found`);
    this.name = 'NotFoundError';
  }
}

interface Snapshot {
  workflows: WorkflowRecord[];
  versions: WorkflowVersion[];
  runs: RunRecord[];
  deployments: Deployment[];
  suites: EvalSuite[];
  evalRuns: EvalRun[];
  templates: MarketplaceTemplate[];
  credentials: CredentialRecord[];
}

/**
 * In-memory reference implementation.
 *
 * `FileStore` extends this and adds durability, so the versioning and query logic
 * lives in exactly one place and the test suite exercises the same code path the
 * app uses.
 */
export class MemoryStore implements Store {
  protected workflows = new Map<string, WorkflowRecord>();
  protected versions = new Map<string, WorkflowVersion>();
  protected runs = new Map<string, RunRecord>();
  protected deployments = new Map<string, Deployment>();
  protected suites = new Map<string, EvalSuite>();
  protected evalRuns = new Map<string, EvalRun>();
  protected templates = new Map<string, MarketplaceTemplate>();
  protected credentials = new Map<string, CredentialRecord>();

  /** Retention ceiling; the oldest runs are dropped past this. */
  protected maxRuns = 500;

  /** Hook for subclasses to persist after a mutation. */
  protected async persist(): Promise<void> {}

  private versionKey(workflowId: string, version: number): string {
    return `${workflowId}@${version}`;
  }

  async listWorkflows(ownerId?: string): Promise<WorkflowRecord[]> {
    return [...this.workflows.values()]
      .filter((w) => !ownerId || w.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWorkflow(id: string): Promise<WorkflowRecord | undefined> {
    return this.workflows.get(id);
  }

  async createWorkflow(record: WorkflowRecord, graph: Workflow): Promise<WorkflowRecord> {
    this.workflows.set(record.id, record);
    this.versions.set(this.versionKey(record.id, 1), {
      workflowId: record.id,
      version: 1,
      status: 'draft',
      graph: { ...graph, id: record.id },
      createdAt: record.createdAt,
      createdBy: record.ownerId,
    });
    await this.persist();
    return record;
  }

  async updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<WorkflowRecord> {
    const existing = this.workflows.get(id);
    if (!existing) throw new NotFoundError('Workflow', id);
    // Callers routinely build a patch from optional request fields, so a key that
    // was simply not sent arrives as an explicit `undefined`. Spreading that would
    // wipe the stored value; only keys with a real value may overwrite.
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<WorkflowRecord>;
    const updated = { ...existing, ...defined, id, updatedAt: new Date().toISOString() };
    this.workflows.set(id, updated);
    await this.persist();
    return updated;
  }

  async deleteWorkflow(id: string): Promise<void> {
    this.workflows.delete(id);
    for (const key of [...this.versions.keys()]) {
      if (key.startsWith(`${id}@`)) this.versions.delete(key);
    }
    for (const [runId, run] of this.runs) {
      if (run.workflowId === id) this.runs.delete(runId);
    }
    for (const [deployId, deployment] of this.deployments) {
      if (deployment.workflowId === id) this.deployments.delete(deployId);
    }
    await this.persist();
  }

  async listVersions(workflowId: string): Promise<WorkflowVersion[]> {
    return [...this.versions.values()]
      .filter((v) => v.workflowId === workflowId)
      .sort((a, b) => b.version - a.version);
  }

  async getVersion(workflowId: string, version: number): Promise<WorkflowVersion | undefined> {
    return this.versions.get(this.versionKey(workflowId, version));
  }

  async saveDraft(workflowId: string, graph: Workflow): Promise<WorkflowVersion> {
    const record = this.workflows.get(workflowId);
    if (!record) throw new NotFoundError('Workflow', workflowId);

    const key = this.versionKey(workflowId, record.draftVersion);
    const existing = this.versions.get(key);
    const version: WorkflowVersion = {
      workflowId,
      version: record.draftVersion,
      status: 'draft',
      graph: { ...graph, id: workflowId },
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      createdBy: existing?.createdBy ?? record.ownerId,
    };
    this.versions.set(key, version);
    this.workflows.set(workflowId, {
      ...record,
      name: graph.name || record.name,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    return version;
  }

  /**
   * Publishing freezes the current draft and opens the next one, so the graph a
   * deployment serves can never be mutated underneath it by an editor.
   */
  async publish(workflowId: string, changelog?: string): Promise<WorkflowVersion> {
    const record = this.workflows.get(workflowId);
    if (!record) throw new NotFoundError('Workflow', workflowId);

    const draftKey = this.versionKey(workflowId, record.draftVersion);
    const draft = this.versions.get(draftKey);
    if (!draft) throw new NotFoundError('Draft version', draftKey);

    const published: WorkflowVersion = { ...draft, status: 'published', changelog };
    this.versions.set(draftKey, published);

    const nextVersion = record.draftVersion + 1;
    this.versions.set(this.versionKey(workflowId, nextVersion), {
      workflowId,
      version: nextVersion,
      status: 'draft',
      graph: structuredClone(draft.graph),
      createdAt: new Date().toISOString(),
      createdBy: record.ownerId,
    });

    this.workflows.set(workflowId, {
      ...record,
      draftVersion: nextVersion,
      publishedVersion: published.version,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    return published;
  }

  async rollback(workflowId: string, toVersion: number): Promise<WorkflowVersion> {
    const source = this.versions.get(this.versionKey(workflowId, toVersion));
    if (!source) throw new NotFoundError('Version', `${workflowId}@${toVersion}`);
    return this.saveDraft(workflowId, structuredClone(source.graph));
  }

  async resolveGraph(workflowId: string, version?: number): Promise<Workflow | undefined> {
    const record = this.workflows.get(workflowId);
    if (!record) return undefined;
    const target = version ?? record.publishedVersion ?? record.draftVersion;
    return this.versions.get(this.versionKey(workflowId, target))?.graph;
  }

  async saveRun(record: RunRecord): Promise<void> {
    this.runs.set(record.id, record);
    if (this.runs.size > this.maxRuns) {
      const oldest = [...this.runs.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, this.runs.size - this.maxRuns);
      for (const run of oldest) this.runs.delete(run.id);
    }
    await this.persist();
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.runs.get(id);
  }

  async listRuns(query: ListRunsQuery = {}): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => !query.workflowId || r.workflowId === query.workflowId)
      .filter((r) => !query.status || r.trace.status === query.status)
      .filter((r) => !query.since || r.createdAt >= query.since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit ?? 100);
  }

  async listDeployments(workflowId?: string): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter((d) => !workflowId || d.workflowId === workflowId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDeploymentBySlug(slug: string): Promise<Deployment | undefined> {
    return [...this.deployments.values()].find((d) => d.slug === slug);
  }

  async saveDeployment(deployment: Deployment): Promise<void> {
    this.deployments.set(deployment.id, deployment);
    await this.persist();
  }

  async deleteDeployment(id: string): Promise<void> {
    this.deployments.delete(id);
    await this.persist();
  }

  async listSuites(workflowId?: string): Promise<EvalSuite[]> {
    return [...this.suites.values()].filter((s) => !workflowId || s.workflowId === workflowId);
  }

  async getSuite(id: string): Promise<EvalSuite | undefined> {
    return this.suites.get(id);
  }

  async saveSuite(suite: EvalSuite): Promise<void> {
    this.suites.set(suite.id, suite);
    await this.persist();
  }

  async listEvalRuns(suiteId?: string): Promise<EvalRun[]> {
    return [...this.evalRuns.values()]
      .filter((r) => !suiteId || r.suiteId === suiteId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async saveEvalRun(run: EvalRun): Promise<void> {
    this.evalRuns.set(run.id, run);
    await this.persist();
  }

  async listTemplates(): Promise<MarketplaceTemplate[]> {
    return [...this.templates.values()].sort(
      (a, b) => Number(b.featured) - Number(a.featured) || b.downloads - a.downloads,
    );
  }

  async getTemplate(id: string): Promise<MarketplaceTemplate | undefined> {
    return this.templates.get(id);
  }

  async saveTemplate(template: MarketplaceTemplate): Promise<void> {
    this.templates.set(template.id, template);
    await this.persist();
  }

  async listCredentials(): Promise<CredentialRecord[]> {
    return [...this.credentials.values()];
  }

  async saveCredential(record: CredentialRecord): Promise<void> {
    this.credentials.set(record.key, record);
    await this.persist();
  }

  async deleteCredential(key: string): Promise<void> {
    this.credentials.delete(key);
    await this.persist();
  }

  protected snapshot(): Snapshot {
    return {
      workflows: [...this.workflows.values()],
      versions: [...this.versions.values()],
      runs: [...this.runs.values()],
      deployments: [...this.deployments.values()],
      suites: [...this.suites.values()],
      evalRuns: [...this.evalRuns.values()],
      templates: [...this.templates.values()],
      credentials: [...this.credentials.values()],
    };
  }

  protected hydrate(snapshot: Partial<Snapshot>): void {
    this.workflows = new Map((snapshot.workflows ?? []).map((w) => [w.id, w]));
    this.versions = new Map(
      (snapshot.versions ?? []).map((v) => [`${v.workflowId}@${v.version}`, v]),
    );
    this.runs = new Map((snapshot.runs ?? []).map((r) => [r.id, r]));
    this.deployments = new Map((snapshot.deployments ?? []).map((d) => [d.id, d]));
    this.suites = new Map((snapshot.suites ?? []).map((s) => [s.id, s]));
    this.evalRuns = new Map((snapshot.evalRuns ?? []).map((r) => [r.id, r]));
    this.templates = new Map((snapshot.templates ?? []).map((t) => [t.id, t]));
    this.credentials = new Map((snapshot.credentials ?? []).map((c) => [c.key, c]));
  }
}

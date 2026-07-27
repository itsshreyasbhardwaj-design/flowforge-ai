import type { Workflow } from '../graph/types';
import type { MarketplaceTemplate } from '../store/types';

const node = (
  id: string,
  type: string,
  label: string,
  x: number,
  y: number,
  config: Record<string, unknown> = {},
) => ({ id, type, label, position: { x, y }, config });

const edge = (source: string, sourcePort: string, target: string, targetPort: string) => ({
  id: `e_${source}_${sourcePort}_${target}_${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
});

/** Retrieval-augmented Q&A with an explicit no-context fallback. */
const ragGraph: Workflow = {
  id: 'tpl_rag',
  name: 'RAG Question Answering',
  description:
    'Index documents, retrieve the most relevant chunks for a question, and answer from them — with a fallback when retrieval finds nothing.',
  concurrency: 8,
  nodes: [
    node('trigger', 'flowforge.trigger_manual', 'Question', 80, 240, {
      sample: { question: 'What is the refund window?', documents: [] },
    }),
    node('pick_docs', 'flowforge.function', 'Pick documents', 340, 60, {
      code: 'return { value: Array.isArray(input?.documents) ? input.documents : [] };',
    }),
    node('pick_question', 'flowforge.function', 'Pick question', 340, 380, {
      code: "return { value: String(input?.question ?? '') };",
    }),
    node('index', 'flowforge.knowledge', 'Index docs', 640, 60, {
      collection: 'docs',
      chunkSize: 800,
      chunkOverlap: 100,
    }),
    node('retrieve', 'flowforge.vector_search', 'Retrieve', 940, 240, {
      collection: 'docs',
      topK: 4,
      minScore: 0.1,
    }),
    node('answer', 'flowforge.llm', 'Answer', 1240, 140, {
      model: 'flowforge/mock',
      systemPrompt:
        'Answer strictly from the provided context. If the context does not contain the answer, say so plainly.',
      prompt: '{{ $.nodes.trigger.output.payload.question }}',
      temperature: 0.2,
      stream: false,
    }),
    node('fallback', 'flowforge.function', 'No context', 1240, 400, {
      code: "return { value: 'I could not find anything relevant in the knowledge base for that question.' };",
    }),
    node('merge', 'flowforge.merge', 'Merge', 1540, 280, { strategy: 'firstPresent' }),
    node('out', 'flowforge.output', 'Answer', 1820, 280, { name: 'answer' }),
  ],
  edges: [
    edge('trigger', 'payload', 'pick_docs', 'input'),
    edge('trigger', 'payload', 'pick_question', 'input'),
    edge('pick_docs', 'value', 'index', 'documents'),
    edge('pick_question', 'value', 'retrieve', 'query'),
    edge('retrieve', 'documents', 'answer', 'context'),
    edge('retrieve', 'empty', 'fallback', 'input'),
    edge('answer', 'text', 'merge', 'a'),
    edge('fallback', 'value', 'merge', 'b'),
    edge('merge', 'value', 'out', 'value'),
  ],
};

/** Planner → researcher → writer → critic, each an independent agent. */
const researchCrewGraph: Workflow = {
  id: 'tpl_research_crew',
  name: 'Multi-Agent Research Crew',
  description:
    'A planner decomposes the brief, a researcher gathers material, a writer drafts, and a critic reviews before the result is returned.',
  concurrency: 4,
  nodes: [
    node('trigger', 'flowforge.trigger_manual', 'Brief', 80, 260, {
      sample: { brief: 'Summarise the state of open-source agent frameworks.' },
    }),
    node('planner', 'flowforge.agent', 'Planner', 380, 260, {
      name: 'Planner',
      role: 'planner',
      model: 'flowforge/mock',
      instructions: 'Break the brief into at most five concrete research questions.',
      maxIterations: 2,
    }),
    node('researcher', 'flowforge.agent', 'Researcher', 700, 140, {
      name: 'Researcher',
      role: 'researcher',
      model: 'flowforge/mock',
      instructions: 'Answer each question with evidence and note what remains uncertain.',
      maxIterations: 3,
    }),
    node('writer', 'flowforge.agent', 'Writer', 1020, 260, {
      name: 'Writer',
      role: 'coder',
      model: 'flowforge/mock',
      instructions: 'Turn the research into a tight, well-structured brief.',
      maxIterations: 2,
    }),
    node('critic', 'flowforge.agent', 'Critic', 1340, 260, {
      name: 'Critic',
      role: 'critic',
      model: 'flowforge/mock',
      instructions: 'Name every unsupported claim. If there are none, say so.',
      maxIterations: 2,
    }),
    node('merge', 'flowforge.merge', 'Assemble', 1640, 260, {
      strategy: 'concatText',
      separator: '\n\n---\n\n',
    }),
    node('out', 'flowforge.output', 'Report', 1920, 260, { name: 'report' }),
  ],
  edges: [
    edge('trigger', 'payload', 'planner', 'task'),
    edge('planner', 'result', 'researcher', 'task'),
    edge('researcher', 'result', 'writer', 'task'),
    edge('writer', 'result', 'critic', 'task'),
    edge('writer', 'result', 'merge', 'a'),
    edge('critic', 'result', 'merge', 'b'),
    edge('merge', 'value', 'out', 'value'),
  ],
};

/** Classify, then branch — with a human gate on the escalation path. */
const triageGraph: Workflow = {
  id: 'tpl_support_triage',
  name: 'Support Ticket Triage',
  description:
    'Classify an inbound ticket, auto-answer the routine ones, and route anything urgent through human approval before it is posted.',
  concurrency: 6,
  nodes: [
    node('trigger', 'flowforge.trigger_webhook', 'Ticket in', 80, 260, { method: 'POST' }),
    node('classify', 'flowforge.llm', 'Classify', 380, 260, {
      model: 'flowforge/mock',
      systemPrompt:
        'Classify the ticket. Reply with JSON: {"severity":"urgent"|"normal","summary":"..."}',
      prompt: '{{ $.nodes.trigger.output.body }}',
      jsonMode: true,
      temperature: 0,
      stream: false,
    }),
    node('branch', 'flowforge.condition', 'Urgent?', 700, 260, {
      operator: 'contains',
      right: 'urgent',
    }),
    node('approve', 'flowforge.human_approval', 'Review', 1020, 140, {
      title: 'Urgent ticket needs a human',
      instructions: 'Confirm the escalation before it is posted to the on-call channel.',
      mode: 'manual',
    }),
    node('reply', 'flowforge.llm', 'Auto-reply', 1020, 400, {
      model: 'flowforge/mock',
      systemPrompt: 'Write a warm, concise reply that resolves the ticket.',
      prompt: '{{ $.nodes.classify.output.text }}',
      stream: false,
    }),
    node('notify', 'flowforge.slack', 'Notify on-call', 1340, 140, {
      text: 'Escalated ticket: {{ $.nodes.classify.output.text }}',
    }),
    node('out', 'flowforge.output', 'Result', 1640, 280, { name: 'result' }),
  ],
  edges: [
    edge('trigger', 'body', 'classify', 'prompt'),
    edge('classify', 'text', 'branch', 'value'),
    edge('branch', 'true', 'approve', 'value'),
    edge('branch', 'false', 'reply', 'prompt'),
    edge('approve', 'approved', 'notify', 'text'),
    edge('reply', 'text', 'out', 'value'),
  ],
};

/** Fan out over a list, running a sub-workflow per item. */
const batchGraph: Workflow = {
  id: 'tpl_batch_enrich',
  name: 'Batch Enrichment Pipeline',
  description:
    'Read a CSV, run an enrichment sub-workflow over every row in parallel, and return the collected results.',
  concurrency: 8,
  nodes: [
    node('trigger', 'flowforge.trigger_manual', 'CSV in', 80, 240, {
      sample: { csv: 'name,company\nAda,Analytical Engines\nGrace,Compilers Inc' },
    }),
    node('parse', 'flowforge.csv', 'Parse CSV', 380, 240, { delimiter: ',', hasHeader: true }),
    node('loop', 'flowforge.loop', 'Enrich each', 700, 240, {
      workflowId: 'tpl_rag',
      mode: 'parallel',
      concurrency: 4,
      continueOnError: true,
    }),
    node('out', 'flowforge.output', 'Rows', 1020, 240, { name: 'rows' }),
  ],
  edges: [
    edge('trigger', 'payload', 'parse', 'text'),
    edge('parse', 'rows', 'loop', 'items'),
    edge('loop', 'results', 'out', 'value'),
  ],
};

const template = (
  graph: Workflow,
  extra: Partial<MarketplaceTemplate> & Pick<MarketplaceTemplate, 'category' | 'tags'>,
): MarketplaceTemplate => ({
  id: graph.id,
  name: graph.name,
  description: graph.description ?? '',
  author: 'FlowForge',
  version: '1.0.0',
  downloads: 0,
  rating: 0,
  ratingCount: 0,
  featured: false,
  graph,
  updatedAt: new Date(0).toISOString(),
  ...extra,
});

/**
 * Templates shipped with the platform.
 *
 * All four run end to end against the offline provider, so a new install has
 * something real to open rather than an empty canvas.
 */
export const BUILTIN_TEMPLATES: MarketplaceTemplate[] = [
  template(ragGraph, {
    category: 'Retrieval',
    tags: ['rag', 'knowledge-base', 'question-answering'],
    featured: true,
    downloads: 1284,
    rating: 4.8,
    ratingCount: 96,
  }),
  template(researchCrewGraph, {
    category: 'Multi-agent',
    tags: ['agents', 'research', 'critique'],
    featured: true,
    downloads: 942,
    rating: 4.6,
    ratingCount: 71,
  }),
  template(triageGraph, {
    category: 'Automation',
    tags: ['support', 'routing', 'human-in-the-loop'],
    downloads: 655,
    rating: 4.4,
    ratingCount: 48,
  }),
  template(batchGraph, {
    category: 'Data',
    tags: ['batch', 'csv', 'parallel'],
    downloads: 418,
    rating: 4.2,
    ratingCount: 30,
  }),
];

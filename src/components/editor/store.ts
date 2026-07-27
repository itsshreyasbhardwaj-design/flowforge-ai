'use client';

import { create } from 'zustand';
import type { Workflow, WorkflowEdge, WorkflowNode } from '@/core/graph/types';
import type { ValidationResult } from '@/core/graph/validate';
import { reduceTrace, type RunTrace, type TraceEvent } from '@/core/runtime/events';
import type { NodeDescriptor } from '@/lib/types';

export type RunPhase = 'idle' | 'running' | 'done';

interface EditorState {
  graph: Workflow;
  catalogue: NodeDescriptor[];
  validation: ValidationResult | null;

  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;

  runPhase: RunPhase;
  trace: RunTrace | null;
  /** Edge ids the current run has activated, for the flowing-edge animation. */
  activeEdges: Set<string>;
  skippedEdges: Set<string>;

  past: Workflow[];
  future: Workflow[];

  setGraph: (graph: Workflow, options?: { history?: boolean; dirty?: boolean }) => void;
  setCatalogue: (catalogue: NodeDescriptor[]) => void;
  setValidation: (validation: ValidationResult | null) => void;

  addNode: (descriptor: NodeDescriptor, position: { x: number; y: number }) => string;
  updateNode: (id: string, patch: Partial<WorkflowNode>) => void;
  updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
  moveNodes: (positions: Record<string, { x: number; y: number }>) => void;
  removeNodes: (ids: string[]) => void;
  duplicateNode: (id: string) => void;

  connect: (edge: Omit<WorkflowEdge, 'id'>) => void;
  removeEdges: (ids: string[]) => void;

  select: (nodeId: string | null, edgeId?: string | null) => void;
  setMeta: (
    patch: Partial<Pick<Workflow, 'name' | 'description' | 'concurrency' | 'variables'>>,
  ) => void;

  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  setSaving: (saving: boolean) => void;

  startRun: () => void;
  applyTraceEvent: (event: TraceEvent) => void;
  finishRun: () => void;
  clearRun: () => void;
}

const HISTORY_LIMIT = 60;

let counter = 0;
function nodeId(type: string): string {
  const base = type.split('.').pop() ?? 'node';
  return `${base}_${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Editor state.
 *
 * The domain `Workflow` is the single source of truth; React Flow nodes and edges
 * are derived from it on render. Keeping React Flow's shape out of the store means
 * autosave, undo, validation, and the run overlay all operate on the same object
 * that gets persisted and executed — there is no second representation to keep in
 * sync.
 */
export const useEditor = create<EditorState>((set, get) => ({
  graph: { id: '', name: '', nodes: [], edges: [], concurrency: 8 },
  catalogue: [],
  validation: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  runPhase: 'idle',
  trace: null,
  activeEdges: new Set(),
  skippedEdges: new Set(),
  past: [],
  future: [],

  setGraph: (graph, options = {}) =>
    set((state) => ({
      graph,
      dirty: options.dirty ?? true,
      past:
        options.history === false
          ? state.past
          : [...state.past, state.graph].slice(-HISTORY_LIMIT),
      future: options.history === false ? state.future : [],
    })),

  setCatalogue: (catalogue) => set({ catalogue }),
  setValidation: (validation) => set({ validation }),

  addNode: (descriptor, position) => {
    const id = nodeId(descriptor.type);
    const node: WorkflowNode = {
      id,
      type: descriptor.type,
      typeVersion: descriptor.version,
      label: descriptor.label,
      position,
      config: structuredClone(descriptor.defaults),
    };
    get().setGraph({ ...get().graph, nodes: [...get().graph.nodes, node] });
    set({ selectedNodeId: id, selectedEdgeId: null });
    return id;
  },

  updateNode: (id, patch) => {
    const { graph, setGraph } = get();
    setGraph({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
  },

  updateNodeConfig: (id, patch) => {
    const { graph, setGraph } = get();
    setGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
      ),
    });
  },

  // Drag events fire continuously; recording each one would make undo useless,
  // so moves mutate without pushing history. The drag-stop handler commits once.
  moveNodes: (positions) =>
    set((state) => ({
      graph: {
        ...state.graph,
        nodes: state.graph.nodes.map((n) =>
          positions[n.id] ? { ...n, position: positions[n.id] } : n,
        ),
      },
      dirty: true,
    })),

  removeNodes: (ids) => {
    const { graph, setGraph, selectedNodeId } = get();
    const doomed = new Set(ids);
    setGraph({
      ...graph,
      nodes: graph.nodes.filter((n) => !doomed.has(n.id)),
      edges: graph.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
    });
    if (selectedNodeId && doomed.has(selectedNodeId)) set({ selectedNodeId: null });
  },

  duplicateNode: (id) => {
    const { graph, setGraph } = get();
    const source = graph.nodes.find((n) => n.id === id);
    if (!source) return;
    const copy: WorkflowNode = {
      ...structuredClone(source),
      id: nodeId(source.type),
      position: { x: source.position.x + 48, y: source.position.y + 48 },
    };
    setGraph({ ...graph, nodes: [...graph.nodes, copy] });
    set({ selectedNodeId: copy.id });
  },

  connect: (edge) => {
    const { graph, setGraph } = get();
    // One value per input port: reconnecting an input replaces the old source
    // rather than silently racing two producers.
    const filtered = graph.edges.filter(
      (e) => !(e.target === edge.target && e.targetPort === edge.targetPort),
    );
    setGraph({
      ...graph,
      edges: [
        ...filtered,
        {
          ...edge,
          id: `e_${edge.source}_${edge.sourcePort}_${edge.target}_${edge.targetPort}`,
        },
      ],
    });
  },

  removeEdges: (ids) => {
    const { graph, setGraph } = get();
    const doomed = new Set(ids);
    setGraph({ ...graph, edges: graph.edges.filter((e) => !doomed.has(e.id)) });
  },

  select: (nodeId, edgeId = null) => set({ selectedNodeId: nodeId, selectedEdgeId: edgeId }),

  setMeta: (patch) => get().setGraph({ ...get().graph, ...patch }),

  undo: () =>
    set((state) => {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        graph: previous,
        past: state.past.slice(0, -1),
        future: [state.graph, ...state.future].slice(0, HISTORY_LIMIT),
        dirty: true,
      };
    }),

  redo: () =>
    set((state) => {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        graph: next,
        past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
        future: rest,
        dirty: true,
      };
    }),

  markSaved: () => set({ dirty: false, saving: false, lastSavedAt: Date.now() }),
  setSaving: (saving) => set({ saving }),

  startRun: () =>
    set({
      runPhase: 'running',
      trace: null,
      activeEdges: new Set(),
      skippedEdges: new Set(),
    }),

  applyTraceEvent: (event) =>
    set((state) => {
      const trace = reduceTrace(state.trace ?? undefined, event);
      if (event.kind === 'edge.activated') {
        const activeEdges = new Set(state.activeEdges);
        activeEdges.add(event.edgeId);
        return { trace, activeEdges };
      }
      if (event.kind === 'edge.skipped') {
        const skippedEdges = new Set(state.skippedEdges);
        skippedEdges.add(event.edgeId);
        return { trace, skippedEdges };
      }
      return { trace };
    }),

  finishRun: () => set({ runPhase: 'done', activeEdges: new Set() }),
  clearRun: () =>
    set({ runPhase: 'idle', trace: null, activeEdges: new Set(), skippedEdges: new Set() }),
}));

/** Convenience selector: the currently selected node, if any. */
export function selectedNode(state: EditorState): WorkflowNode | undefined {
  return state.graph.nodes.find((n) => n.id === state.selectedNodeId);
}

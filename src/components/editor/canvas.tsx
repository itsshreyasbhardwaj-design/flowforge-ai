'use client';

import { useCallback, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { isPortCompatible } from '@/core/graph/types';
import { CATEGORY_COLOR } from '@/lib/types';
import { truncate } from '@/lib/format';
import { useEditor } from './store';
import { FlowNodeCard, type FlowNodeData } from './node-card';

const nodeTypes = { flowforge: FlowNodeCard };
const SNAP_GRID: [number, number] = [16, 16];

function CanvasInner() {
  const graph = useEditor((s) => s.graph);
  const catalogue = useEditor((s) => s.catalogue);
  const validation = useEditor((s) => s.validation);
  const trace = useEditor((s) => s.trace);
  const activeEdges = useEditor((s) => s.activeEdges);
  const skippedEdges = useEditor((s) => s.skippedEdges);
  const selectedNodeId = useEditor((s) => s.selectedNodeId);

  const addNode = useEditor((s) => s.addNode);
  const moveNodes = useEditor((s) => s.moveNodes);
  const removeNodes = useEditor((s) => s.removeNodes);
  const removeEdges = useEditor((s) => s.removeEdges);
  const connect = useEditor((s) => s.connect);
  const select = useEditor((s) => s.select);

  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<Record<string, { x: number; y: number }> | null>(null);

  const descriptorFor = useCallback(
    (type: string) => catalogue.find((d) => d.type === type),
    [catalogue],
  );

  const errorNodeIds = useMemo(
    () => new Set((validation?.errors ?? []).map((e) => e.nodeId).filter(Boolean) as string[]),
    [validation],
  );

  const nodes: Node<FlowNodeData>[] = useMemo(
    () =>
      graph.nodes.map((node) => {
        const descriptor = descriptorFor(node.type);
        const nodeTrace = trace?.nodes[node.id];
        return {
          id: node.id,
          type: 'flowforge',
          position: node.position,
          selected: node.id === selectedNodeId,
          data: {
            label: node.label ?? descriptor?.label ?? node.type,
            descriptor,
            type: node.type,
            disabled: node.disabled,
            hasError: errorNodeIds.has(node.id),
            status: nodeTrace?.status,
            durationMs: nodeTrace?.durationMs,
            summary: summarize(node.config),
          },
        };
      }),
    [graph.nodes, descriptorFor, trace, selectedNodeId, errorNodeIds],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourcePort,
        target: edge.target,
        targetHandle: edge.targetPort,
        label: edge.label,
        animated: activeEdges.has(edge.id),
        className: activeEdges.has(edge.id)
          ? 'edge-active'
          : skippedEdges.has(edge.id)
            ? 'edge-skipped'
            : undefined,
      })),
    [graph.edges, activeEdges, skippedEdges],
  );

  /**
   * Rejects a connection the executor would reject anyway.
   *
   * Validating port compatibility here means an invalid edge can never be drawn,
   * rather than being drawn and then flagged — the handle simply refuses to snap.
   */
  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;

      const sourceNode = graph.nodes.find((n) => n.id === connection.source);
      const targetNode = graph.nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return false;

      const outPort = descriptorFor(sourceNode.type)?.outputs.find(
        (p) => p.id === connection.sourceHandle,
      );
      const inPort = descriptorFor(targetNode.type)?.inputs.find(
        (p) => p.id === connection.targetHandle,
      );
      if (!outPort || !inPort) return false;
      if (!isPortCompatible(outPort.type, inPort.type)) return false;

      return !createsCycle(graph.edges, connection.source, connection.target);
    },
    [graph, descriptorFor],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const positions: Record<string, { x: number; y: number }> = {};
      const removed: string[] = [];

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          positions[change.id] = change.position;
        } else if (change.type === 'remove') {
          removed.push(change.id);
        }
      }

      if (Object.keys(positions).length) moveNodes(positions);
      if (removed.length) removeNodes(removed);
    },
    [moveNodes, removeNodes],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
      select(selectedNodes[0]?.id ?? null, selectedEdges[0]?.id ?? null);
    },
    [select],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/flowforge-node');
      const descriptor = catalogue.find((d) => d.type === type);
      if (!descriptor) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(descriptor, {
        x: Math.round(position.x / 16) * 16,
        y: Math.round(position.y / 16) * 16,
      });
    },
    [catalogue, screenToFlowPosition, addNode],
  );

  return (
    <div ref={wrapper} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={(changes) => {
          const removed = changes
            .filter((c): c is { type: 'remove'; id: string } => c.type === 'remove')
            .map((c) => c.id);
          if (removed.length) removeEdges(removed);
        }}
        onConnect={(connection) => {
          if (!connection.source || !connection.target) return;
          connect({
            source: connection.source,
            sourcePort: connection.sourceHandle ?? 'value',
            target: connection.target,
            targetPort: connection.targetHandle ?? 'value',
          });
        }}
        isValidConnection={isValidConnection}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={() => {
          dragOrigin.current = Object.fromEntries(
            graph.nodes.map((n) => [n.id, { ...n.position }]),
          );
        }}
        onNodeDragStop={() => {
          // Commit one history entry for the whole drag rather than one per frame.
          const origin = dragOrigin.current;
          dragOrigin.current = null;
          if (!origin) return;
          const moved = graph.nodes.some(
            (n) =>
              origin[n.id] &&
              (origin[n.id].x !== n.position.x || origin[n.id].y !== n.position.y),
          );
          if (moved) {
            const restored = {
              ...graph,
              nodes: graph.nodes.map((n) => ({ ...n, position: origin[n.id] ?? n.position })),
            };
            useEditor.setState({
              past: [...useEditor.getState().past, restored].slice(-60),
              future: [],
            });
          }
        }}
        onDrop={onDrop}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onPaneClick={() => select(null, null)}
        snapToGrid
        snapGrid={SNAP_GRID}
        minZoom={0.15}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Meta', 'Shift']}
        selectionKeyCode="Shift"
        panOnScroll
        selectionOnDrag
        connectionRadius={28}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1e1e28" />
        <Controls
          className="!border-border !bg-surface-2 [&_button]:!border-border [&_button]:!bg-surface-2 [&_button]:!fill-ink-muted [&_button:hover]:!bg-surface-3 !rounded-lg !border !shadow-xl"
          showInteractive={false}
        />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(8,8,11,0.82)"
          nodeColor={(node) => {
            const data = node.data as FlowNodeData;
            return data.descriptor ? CATEGORY_COLOR[data.descriptor.category] : '#f87171';
          }}
          nodeStrokeWidth={0}
        />
      </ReactFlow>

      {graph.nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="border-border-strong bg-surface/70 pointer-events-auto max-w-sm rounded-xl border border-dashed px-6 py-5 text-center backdrop-blur">
            <p className="text-ink text-sm font-medium">This canvas is empty</p>
            <p className="text-ink-subtle mt-1.5 text-xs leading-relaxed">
              Drag a node in from the library on the left, or press{' '}
              <kbd className="border-border bg-surface-3 rounded border px-1 font-mono text-[10px]">
                ⌘K
              </kbd>{' '}
              to describe what you want and let the assistant build it.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A short, human-readable gist of a node's configuration for the card body. */
function summarize(config: Record<string, unknown>): string | undefined {
  for (const key of [
    'prompt',
    'instructions',
    'template',
    'url',
    'code',
    'collection',
    'name',
  ]) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 90);
  }
  return undefined;
}

/** Depth-first reachability check: would source→target close a loop? */
function createsCycle(
  edges: { source: string; target: string }[],
  source: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

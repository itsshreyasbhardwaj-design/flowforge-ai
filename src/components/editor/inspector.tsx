'use client';

import { useMemo } from 'react';
import * as Icons from 'lucide-react';
import type { ConfigFieldUi } from '@/core/registry/definition';
import { CATEGORY_COLOR, type NodeDescriptor } from '@/lib/types';
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  Switch,
  Textarea,
} from '@/components/ui/primitives';
import { prettyJson } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useEditor } from './store';

/**
 * Configuration panel.
 *
 * The form is generated from the node descriptor rather than hand-written per
 * node type: `configUi` supplies widget hints and ordering, and `defaults` supplies
 * the value shape. That is what makes a third-party node a first-class citizen —
 * it gets the same inspector as a built-in with no UI code of its own.
 */
export function Inspector() {
  const graph = useEditor((s) => s.graph);
  const catalogue = useEditor((s) => s.catalogue);
  const validation = useEditor((s) => s.validation);
  const selectedNodeId = useEditor((s) => s.selectedNodeId);
  const trace = useEditor((s) => s.trace);
  const updateNode = useEditor((s) => s.updateNode);
  const updateNodeConfig = useEditor((s) => s.updateNodeConfig);
  const removeNodes = useEditor((s) => s.removeNodes);
  const duplicateNode = useEditor((s) => s.duplicateNode);
  const setMeta = useEditor((s) => s.setMeta);

  const node = graph.nodes.find((n) => n.id === selectedNodeId);
  const descriptor = catalogue.find((d) => d.type === node?.type);

  const issues = useMemo(
    () => (validation?.issues ?? []).filter((i) => i.nodeId === selectedNodeId),
    [validation, selectedNodeId],
  );

  if (!node) {
    return (
      <aside className="border-border bg-surface flex w-80 shrink-0 flex-col overflow-y-auto border-l">
        <PanelHeader title="Workflow" />
        <div className="space-y-4 p-4">
          <Field label="Name">
            <Input value={graph.name} onChange={(e) => setMeta({ name: e.target.value })} />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              value={graph.description ?? ''}
              onChange={(e) => setMeta({ description: e.target.value })}
              placeholder="What does this workflow do?"
            />
          </Field>
          <Field label="Max concurrency" help="How many nodes may execute at the same time.">
            <Input
              type="number"
              min={1}
              max={64}
              className="numeric"
              value={graph.concurrency ?? 8}
              onChange={(e) => setMeta({ concurrency: Number(e.target.value) || 1 })}
            />
          </Field>
          <Field label="Variables" help="Available in any expression as {{ $.vars.name }}.">
            <JsonEditor
              value={graph.variables ?? {}}
              onChange={(value) => setMeta({ variables: value as Record<string, unknown> })}
              rows={5}
            />
          </Field>

          <div className="border-border bg-surface-2 rounded-lg border p-3">
            <p className="text-ink-subtle text-[11px] leading-relaxed">
              Select a node to configure it. Values support{' '}
              <code className="bg-surface-3 text-accent-soft rounded px-1 font-mono text-[10px]">
                {'{{ $.nodes.id.output.port }}'}
              </code>{' '}
              expressions.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const nodeTrace = trace?.nodes[node.id];
  const fields = orderedFields(descriptor);

  return (
    <aside className="border-border bg-surface flex w-80 shrink-0 flex-col overflow-y-auto border-l">
      <PanelHeader
        title={node.label ?? descriptor?.label ?? node.type}
        subtitle={node.type}
        color={descriptor ? CATEGORY_COLOR[descriptor.category] : undefined}
        actions={
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Duplicate node"
              onClick={() => duplicateNode(node.id)}
            >
              <Icons.Copy />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Delete node"
              className="hover:text-danger"
              onClick={() => removeNodes([node.id])}
            >
              <Icons.Trash2 />
            </Button>
          </>
        }
      />

      {!descriptor ? (
        <div className="border-danger/30 bg-danger/10 text-danger m-4 rounded-lg border p-3 text-xs">
          No plugin provides <code className="font-mono">{node.type}</code>. Install it, or
          delete this node.
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="mx-4 mt-4 space-y-1.5">
          {issues.map((issue, index) => (
            <p
              key={index}
              className={cn(
                'flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug',
                issue.severity === 'error'
                  ? 'border-danger/25 bg-danger/10 text-danger'
                  : 'border-warning/25 bg-warning/10 text-warning',
              )}
            >
              <Icons.AlertTriangle className="mt-px size-3 shrink-0" />
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="space-y-4 p-4">
        <Field label="Label">
          <Input
            value={node.label ?? ''}
            onChange={(e) => updateNode(node.id, { label: e.target.value })}
            placeholder={descriptor?.label}
          />
        </Field>

        {fields.map(([key, ui]) => (
          <ConfigField
            key={key}
            name={key}
            ui={ui}
            descriptor={descriptor}
            value={node.config[key]}
            onChange={(value) => updateNodeConfig(node.id, { [key]: value })}
          />
        ))}

        <details className="group border-border bg-surface-2 rounded-lg border">
          <summary className="text-ink-muted flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[11px] font-medium">
            <Icons.ChevronRight className="size-3 transition-transform group-open:rotate-90" />
            Execution policy
          </summary>
          <div className="border-border space-y-3 border-t p-3">
            <Field label="Retries" help="Extra attempts after the first failure.">
              <Input
                type="number"
                min={0}
                max={10}
                className="numeric"
                value={node.policy?.retries ?? 0}
                onChange={(e) =>
                  updateNode(node.id, {
                    policy: { ...node.policy, retries: Number(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                min={100}
                step={500}
                className="numeric"
                value={node.policy?.timeoutMs ?? 60_000}
                onChange={(e) =>
                  updateNode(node.id, {
                    policy: { ...node.policy, timeoutMs: Number(e.target.value) || 60_000 },
                  })
                }
              />
            </Field>
            <Field label="On error">
              <Select
                value={node.policy?.onError ?? 'fail'}
                onChange={(e) =>
                  updateNode(node.id, {
                    policy: { ...node.policy, onError: e.target.value as 'fail' },
                  })
                }
              >
                <option value="fail">Fail the run</option>
                <option value="continue">Skip and continue</option>
                <option value="route">Send to the error port</option>
              </Select>
            </Field>
            <div className="flex items-center justify-between">
              <Label>Disabled</Label>
              <Switch
                label="Disable node"
                checked={Boolean(node.disabled)}
                onCheckedChange={(disabled) => updateNode(node.id, { disabled })}
              />
            </div>
          </div>
        </details>

        {nodeTrace ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label>Last run</Label>
              <Badge
                tone={
                  nodeTrace.status === 'succeeded'
                    ? 'positive'
                    : nodeTrace.status === 'failed'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {nodeTrace.status}
              </Badge>
            </div>
            {nodeTrace.error ? (
              <pre className="border-danger/25 bg-danger/8 text-danger max-h-40 overflow-auto rounded-lg border p-2 font-mono text-[10px] leading-relaxed">
                {nodeTrace.error.message}
              </pre>
            ) : null}
            <pre className="border-border bg-surface-2 text-ink-muted max-h-56 overflow-auto rounded-lg border p-2 font-mono text-[10px] leading-relaxed">
              {prettyJson(nodeTrace.outputs ?? {}, 4000)}
            </pre>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function orderedFields(descriptor: NodeDescriptor | undefined): [string, ConfigFieldUi][] {
  if (!descriptor) return [];
  return descriptor.configKeys
    .map((key) => [key, descriptor.configUi[key] ?? {}] as [string, ConfigFieldUi])
    .sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99));
}

function ConfigField({
  name,
  ui,
  descriptor,
  value,
  onChange,
}: {
  name: string;
  ui: ConfigFieldUi;
  descriptor: NodeDescriptor | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = ui.label ?? humanize(name);
  const widget = ui.widget ?? inferWidget(value);

  // The model list is populated from live providers, so it reflects whatever
  // backend is actually configured rather than a hard-coded list.
  const options = name === 'model' && descriptor ? undefined : ui.options;

  switch (widget) {
    case 'switch':
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label>{label}</Label>
            {ui.help ? <p className="text-ink-subtle mt-0.5 text-[10px]">{ui.help}</p> : null}
          </div>
          <Switch label={label} checked={Boolean(value)} onCheckedChange={onChange} />
        </div>
      );

    case 'number':
      return (
        <Field label={label} help={ui.help}>
          <Input
            type="number"
            className="numeric"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) =>
              onChange(e.target.value === '' ? undefined : Number(e.target.value))
            }
          />
        </Field>
      );

    case 'select':
      return (
        <Field label={label} help={ui.help}>
          {options ? (
            <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <ModelOrTextInput name={name} value={value} onChange={onChange} />
          )}
        </Field>
      );

    case 'textarea':
    case 'code':
      return (
        <Field label={label} help={ui.help}>
          <Textarea
            rows={widget === 'code' ? 8 : 4}
            spellCheck={widget !== 'code'}
            className={cn(widget === 'code' && 'font-mono text-[11px] leading-relaxed')}
            value={typeof value === 'string' ? value : ''}
            placeholder={ui.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );

    case 'json':
      return (
        <Field label={label} help={ui.help}>
          <JsonEditor value={value} onChange={onChange} />
        </Field>
      );

    case 'secret':
      return (
        <Field label={label} help={ui.help ?? 'Stored encrypted; redacted from traces.'}>
          <Input
            type="password"
            autoComplete="off"
            value={typeof value === 'string' ? value : ''}
            placeholder="Leave blank to use the saved credential"
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        </Field>
      );

    default:
      return (
        <Field label={label} help={ui.help}>
          <Input
            value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
            placeholder={ui.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
  }
}

/** Model fields get a datalist of every model the configured providers expose. */
function ModelOrTextInput({
  name,
  value,
  onChange,
}: {
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const providers = useEditor((s) => s.catalogue);
  void providers;
  return (
    <Input
      list={name === 'model' ? 'flowforge-models' : undefined}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function JsonEditor({
  value,
  onChange,
  rows = 4,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  rows?: number;
}) {
  return (
    <Textarea
      rows={rows}
      spellCheck={false}
      className="font-mono text-[11px] leading-relaxed"
      defaultValue={prettyJson(value ?? {}, 6000)}
      onBlur={(e) => {
        // Parse on blur, not on every keystroke: half-typed JSON is not an error.
        try {
          onChange(JSON.parse(e.target.value || '{}'));
        } catch {
          /* keep the previous value; the textarea still shows what was typed */
        }
      }}
    />
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {help ? <p className="text-ink-subtle text-[10px] leading-snug">{help}</p> : null}
    </div>
  );
}

function PanelHeader({
  title,
  subtitle,
  color,
  actions,
}: {
  title: string;
  subtitle?: string;
  color?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="border-border bg-surface/95 sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-3 backdrop-blur">
      {color ? (
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-ink truncate text-sm font-semibold">{title}</h2>
        {subtitle ? (
          <p className="text-ink-subtle truncate font-mono text-[10px]">{subtitle}</p>
        ) : null}
      </div>
      {actions}
    </header>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function inferWidget(value: unknown): ConfigFieldUi['widget'] {
  if (typeof value === 'boolean') return 'switch';
  if (typeof value === 'number') return 'number';
  if (value && typeof value === 'object') return 'json';
  return 'text';
}

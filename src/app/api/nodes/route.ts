import { getRuntime } from '@/server/runtime';
import { json, route } from '@/server/api';

export const dynamic = 'force-dynamic';

/**
 * The node catalogue the editor renders from.
 *
 * Zod schemas cannot cross the wire, so each definition is projected into a
 * serialisable descriptor. The inspector builds its form from `configUi` plus the
 * schema's default values, which means a third-party node gets a working form for
 * free.
 */
export const GET = route(async () => {
  const { registry } = await getRuntime();

  const nodes = registry.list().map((def) => {
    const shape =
      (def.configSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    const defaults = def.configSchema.safeParse({});

    return {
      type: def.type,
      version: def.version,
      label: def.label,
      description: def.description,
      category: def.category,
      icon: def.icon,
      accent: def.accent ?? 'slate',
      docsUrl: def.docsUrl,
      inputs: def.inputs,
      outputs: def.outputs,
      secrets: def.secrets ?? [],
      capabilities: def.capabilities ?? {},
      configKeys: Object.keys(shape),
      configUi: def.configUi ?? {},
      defaults: defaults.success ? defaults.data : {},
    };
  });

  return json({
    nodes,
    providers: registry.listLLMProviders().map((p) => ({ name: p.name, models: p.models })),
    plugins: registry.listPlugins().map((p) => ({ name: p.name, version: p.version })),
  });
});

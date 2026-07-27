import { getRuntime } from '@/server/runtime';
import { json, route } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.toLowerCase();
  const category = url.searchParams.get('category');

  const { store } = await getRuntime();
  let templates = await store.listTemplates();

  if (category) templates = templates.filter((t) => t.category === category);
  if (query) {
    templates = templates.filter((t) =>
      [t.name, t.description, ...t.tags].join(' ').toLowerCase().includes(query),
    );
  }

  return json({
    templates: templates.map(({ graph, ...rest }) => ({
      ...rest,
      nodeCount: graph.nodes.length,
    })),
    categories: [...new Set((await store.listTemplates()).map((t) => t.category))],
  });
});

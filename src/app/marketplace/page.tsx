import { Download, Star } from 'lucide-react';
import { getRuntime } from '@/server/runtime';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/primitives';
import { InstallTemplateButton } from '@/components/marketplace/install-button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace' };

export default async function MarketplacePage() {
  const { store } = await getRuntime();
  const templates = await store.listTemplates();
  const featured = templates.filter((t) => t.featured);
  const rest = templates.filter((t) => !t.featured);

  return (
    <>
      <PageHeader
        title="Marketplace"
        description="Ready-made workflows you can install and edit. Every template runs end to end with no API keys."
      />

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-6">
        {featured.length > 0 ? (
          <section>
            <h2 className="text-ink-subtle mb-3 text-[10px] font-semibold tracking-widest uppercase">
              Featured
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {featured.map((template) => (
                <article
                  key={template.id}
                  className="panel border-accent/25 from-accent/8 flex flex-col gap-3 bg-gradient-to-br to-transparent p-5"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-ink text-sm font-semibold">{template.name}</h3>
                      <p className="text-ink-muted mt-1.5 text-xs leading-relaxed">
                        {template.description}
                      </p>
                    </div>
                    <Badge tone="accent">{template.category}</Badge>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {template.tags.map((tag) => (
                      <span
                        key={tag}
                        className="border-border bg-surface-2 text-ink-subtle rounded border px-1.5 py-0.5 text-[10px]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  <div className="text-ink-subtle mt-auto flex items-center gap-4 text-[11px]">
                    <span className="flex items-center gap-1">
                      <Star className="fill-warning text-warning size-3" />
                      <span className="numeric">{template.rating.toFixed(1)}</span>
                      <span className="opacity-60">({template.ratingCount})</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <Download className="size-3" />
                      <span className="numeric">{template.downloads.toLocaleString()}</span>
                    </span>
                    <span className="numeric">{template.graph.nodes.length} nodes</span>
                    <InstallTemplateButton templateId={template.id} className="ml-auto" />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {rest.length > 0 ? (
          <section>
            <h2 className="text-ink-subtle mb-3 text-[10px] font-semibold tracking-widest uppercase">
              All templates
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {rest.map((template) => (
                <article key={template.id} className="panel flex flex-col gap-3 p-4">
                  <div>
                    <h3 className="text-ink text-sm font-semibold">{template.name}</h3>
                    <p className="text-ink-muted mt-1.5 line-clamp-3 text-[11px] leading-relaxed">
                      {template.description}
                    </p>
                  </div>
                  <div className="text-ink-subtle mt-auto flex items-center gap-3 text-[11px]">
                    <Badge>{template.category}</Badge>
                    <span className="numeric">{template.graph.nodes.length} nodes</span>
                    <InstallTemplateButton templateId={template.id} className="ml-auto" />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

import { cn } from '@/lib/cn';

/** Shared page chrome so every console surface has the same rhythm. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'border-border bg-surface flex shrink-0 flex-wrap items-end gap-4 border-b px-6 py-5',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="text-ink text-lg font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-ink-subtle mt-1 max-w-2xl text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'accent';
}) {
  const toneClass = {
    neutral: 'text-ink',
    positive: 'text-positive',
    warning: 'text-warning',
    danger: 'text-danger',
    accent: 'text-accent-soft',
  }[tone];

  return (
    <div className="panel px-4 py-3">
      <p className="text-ink-subtle text-[10px] font-medium tracking-widest uppercase">
        {label}
      </p>
      <p className={cn('numeric mt-1.5 text-2xl font-semibold tracking-tight', toneClass)}>
        {value}
      </p>
      {hint ? <p className="text-ink-subtle mt-0.5 text-[11px]">{hint}</p> : null}
    </div>
  );
}

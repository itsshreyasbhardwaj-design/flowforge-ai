'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookOpen,
  FlaskConical,
  KeyRound,
  Rocket,
  Store,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/runs', label: 'Runs', icon: Activity },
  { href: '/observability', label: 'Observability', icon: BookOpen },
  { href: '/evaluations', label: 'Evaluations', icon: FlaskConical },
  { href: '/deployments', label: 'Deployments', icon: Rocket },
  { href: '/marketplace', label: 'Marketplace', icon: Store },
  { href: '/settings', label: 'Credentials', icon: KeyRound },
] as const;

/**
 * Icon rail.
 *
 * A 56px rail rather than a full sidebar: the canvas is the product, and every
 * pixel of horizontal space it does not get is a pixel of workflow a user cannot
 * see. Labels appear on hover.
 */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="border-border bg-surface z-30 flex w-14 shrink-0 flex-col items-center gap-1 border-r py-3"
    >
      <Link
        href="/workflows"
        aria-label="FlowForge home"
        className="from-accent to-accent-soft mb-3 grid size-9 place-items-center rounded-xl bg-gradient-to-br text-white shadow-[0_6px_18px_-8px_var(--color-accent)] transition-transform hover:scale-105"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
          <path
            d="M5 6h14M5 12h9M5 18h5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="18.5" cy="12" r="2.2" fill="currentColor" />
          <circle cx="14.5" cy="18" r="2.2" fill="currentColor" />
        </svg>
      </Link>

      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative grid size-9 place-items-center rounded-lg transition-colors',
              active
                ? 'bg-accent/14 text-accent-soft'
                : 'text-ink-subtle hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon className="size-[18px]" />
            {active ? (
              <span className="bg-accent absolute -left-3 h-5 w-[3px] rounded-r-full" />
            ) : null}
            <span
              role="tooltip"
              className="border-border bg-surface-3 text-ink pointer-events-none absolute left-full z-50 ml-2 hidden rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-xl group-hover:block"
            >
              {label}
            </span>
          </Link>
        );
      })}

      <div className="text-ink-subtle/60 mt-auto text-[9px] font-medium tracking-widest">
        v0.1
      </div>
    </nav>
  );
}

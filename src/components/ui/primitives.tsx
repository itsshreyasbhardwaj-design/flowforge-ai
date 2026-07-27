'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/cn';

const buttonStyles = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-all duration-150 disabled:pointer-events-none disabled:opacity-45 focus-visible:focus-ring active:scale-[0.98] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-white shadow-[0_1px_0_0_rgba(255,255,255,0.14)_inset,0_6px_18px_-8px_var(--color-accent)] hover:bg-accent-soft',
        secondary:
          'bg-surface-2 text-ink border border-border hover:bg-surface-3 hover:border-border-strong',
        ghost: 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        danger: 'bg-danger/12 text-danger border border-danger/25 hover:bg-danger/20',
        outline: 'border border-border-strong text-ink hover:bg-surface-2',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-9 px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 px-5 text-sm [&_svg]:size-4',
        icon: 'size-9 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      ref={ref}
      className={cn(buttonStyles({ variant, size }), className)}
      {...props}
    />
  );
});

const badgeStyles = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-2 text-ink-muted',
        accent: 'border-accent/30 bg-accent/12 text-accent-soft',
        positive: 'border-positive/25 bg-positive/12 text-positive',
        warning: 'border-warning/25 bg-warning/12 text-warning',
        danger: 'border-danger/25 bg-danger/12 text-danger',
        info: 'border-info/25 bg-info/12 text-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeStyles> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeStyles({ tone }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel', className)} {...props} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'border-border bg-surface-2 text-ink h-9 w-full rounded-lg border px-3 text-sm transition-colors',
          'placeholder:text-ink-subtle hover:border-border-strong focus-visible:focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'border-border bg-surface-2 text-ink w-full resize-y rounded-lg border px-3 py-2 text-sm leading-relaxed transition-colors',
        'placeholder:text-ink-subtle hover:border-border-strong focus-visible:focus-ring',
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'border-border bg-surface-2 text-ink h-9 w-full appearance-none rounded-lg border px-3 text-sm transition-colors',
        'hover:border-border-strong focus-visible:focus-ring',
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%239a9aab%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-8",
        className,
      )}
      {...props}
    />
  );
});

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'focus-visible:focus-ring relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-accent/50 bg-accent' : 'border-border bg-surface-3',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-transform duration-150',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-ink-muted text-xs font-medium tracking-wide', className)}
      {...props}
    />
  );
}

export function Separator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="separator" className={cn('bg-border h-px w-full', className)} {...props} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-surface-2 animate-pulse rounded-md', className)} {...props} />;
}

/** Consistent empty state, so every surface fails the same way. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon ? (
        <div className="border-border bg-surface-2 text-ink-subtle grid size-11 place-items-center rounded-xl border">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-ink text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-ink-subtle mx-auto max-w-sm text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export { buttonStyles };

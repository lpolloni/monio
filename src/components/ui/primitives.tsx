import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-12 w-full rounded-2xl bg-surface px-4 text-[15px] text-fg placeholder:text-fg-subtle hairline outline-none transition-shadow focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-none aria-invalid:shadow-[0_0_0_2px_var(--negative)]",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-[13px] font-medium text-fg-muted", className)} {...props} />;
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("skeleton", className)} {...props} />;
}

export function Badge({
  className,
  tone = "neutral",
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "positive" | "negative" | "warning" | "accent" }) {
  const tones = {
    neutral: "bg-surface-2 text-fg-muted",
    positive: "bg-positive-soft text-positive",
    negative: "bg-negative-soft text-negative",
    warning: "bg-warning-soft text-warning",
    accent: "bg-accent-soft text-accent",
  } as const;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide", tones[tone], className)}
      {...props}
    />
  );
}

/** Section heading used across pages: small caps label + optional action. */
export function SectionHeader({ title, action, className }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex items-end justify-between gap-4", className)}>
      <h2 className="text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{title}</h2>
      {action}
    </div>
  );
}

export function Surface({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-[1.75rem] bg-bg-elevated/80 hairline shadow-soft", className)} {...props} />;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-[2.6rem] leading-[1.02] tracking-[-0.01em] text-fg sm:text-[3.2rem]">{title}</h1>
        {subtitle ? <p className="mt-2 max-w-xl text-[15px] text-fg-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

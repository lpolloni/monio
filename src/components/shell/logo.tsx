import { cn } from "@/lib/utils";

/** Monio mark: a core with a satellite on its orbit — wealth with its institutions around it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <defs>
        <linearGradient id="monio-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.84 0.14 165)" />
          <stop offset="55%" stopColor="oklch(0.76 0.13 235)" />
          <stop offset="100%" stopColor="oklch(0.7 0.17 290)" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="8.5" fill="url(#monio-g)" />
      <ellipse cx="16" cy="16" rx="14" ry="6.2" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.2" transform="rotate(-28 16 16)" />
      <circle cx="27.4" cy="10.4" r="2.3" fill="currentColor" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-fg", className)}>
      <LogoMark />
      <span className="font-display text-[1.65rem] italic leading-none tracking-tight">monio</span>
    </span>
  );
}

"use client";

import { LoaderCircle, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  clearLabel: string;
  busy?: boolean;
  className?: string;
}

/** Pill search input with a one-tap clear button; 16px text on phones so iOS never zooms on focus. */
export function SearchField({ value, onChange, label, placeholder, clearLabel, busy = false, className }: SearchFieldProps) {
  const Icon = busy ? LoaderCircle : Search;
  return (
    <div className={cn("relative", className)}>
      <Icon className={cn("pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-fg-subtle", busy && "animate-spin")} />
      <input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder={placeholder}
        className="h-11 w-full appearance-none rounded-full bg-surface pr-11 pl-11 text-[16px] text-fg placeholder:text-fg-subtle hairline outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] md:text-[14px] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={clearLabel}
          className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-fg-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

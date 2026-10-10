"use client";

import { motion } from "motion/react";
import { useId } from "react";
import { cn } from "@/lib/utils";

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode; ariaLabel?: string }[];
  className?: string;
  size?: "sm" | "md";
  label: string;
}

/** Pill segmented control with a shared-layout highlight that glides between options. */
export function Segmented<T extends string>({ value, onChange, options, className, size = "md", label }: SegmentedProps<T>) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn("relative inline-flex rounded-full bg-surface-2 p-1 hairline", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative z-0 rounded-full font-medium transition-colors",
              size === "sm" ? "h-7 px-3 text-xs" : "h-8 px-3.5 text-[13px]",
              active ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 -z-10 rounded-full bg-bg-elevated shadow-soft"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            ) : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/lib/utils";

interface OptionMenuProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  /** Names the group for assistive technology; shown before the value when `showLabel` is set. */
  label: string;
  showLabel?: boolean;
  className?: string;
  align?: "start" | "end";
}

/** One compact button showing the current choice; the options open in a menu. */
export function OptionMenu<T extends string>({ value, onChange, options, label, showLabel = false, className, align = "start" }: OptionMenuProps<T>) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`${label}: ${current}`}
        className={cn(
          "inline-flex h-9 max-w-full shrink-0 items-center gap-1.5 rounded-full bg-surface-2 pr-2.5 pl-3.5 text-[13px] font-medium text-fg hairline transition hover:shadow-soft data-[state=open]:shadow-soft",
          className,
        )}
      >
        {showLabel ? <span className="font-normal text-fg-muted">{label}</span> : null}
        <span className="truncate">{current}</span>
        <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 overflow-y-auto rounded-2xl bg-bg-elevated p-1.5 shadow-float hairline"
        >
          <DropdownMenu.Label className="px-3 pt-1.5 pb-1 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{label}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                className="flex h-10 cursor-pointer select-none items-center justify-between gap-6 rounded-xl px-3 text-[14px] text-fg outline-none data-[highlighted]:bg-surface-2"
              >
                {o.label}
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4 text-accent" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

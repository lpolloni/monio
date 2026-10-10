"use client";

import { useTranslations } from "use-intl";
import { cn } from "@/lib/utils";
import { CategoryIcon } from "./category-icon";

export interface PickerCategory {
  id: string;
  slug: string;
  kind: string;
}

/** Grid of categories grouped by kind; the selected one is highlighted. */
export function CategoryPicker({
  categories,
  value,
  onSelect,
  direction,
  disabled,
}: {
  categories: PickerCategory[];
  value: string | null;
  onSelect: (id: string) => void;
  direction?: "in" | "out";
  disabled?: boolean;
}) {
  const t = useTranslations("categories");
  const kinds = direction === "in" ? ["income", "transfer", "expense"] : ["expense", "transfer", "income"];
  return (
    <div className="flex flex-col gap-4">
      {kinds.map((kind) => (
        <div key={kind} className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {categories
            .filter((c) => c.kind === kind)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(c.id)}
                aria-pressed={value === c.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12.5px] transition disabled:opacity-50",
                  value === c.id ? "bg-accent-soft text-fg hairline" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <CategoryIcon slug={c.slug} size="sm" />
                <span className="truncate">{t(c.slug as "groceries")}</span>
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

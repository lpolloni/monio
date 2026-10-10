"use client";

import { ArrowUpRight, FileUp, Wallet } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { createContext, use, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Sheet } from "@/components/ui/sheet";

const AddSheetContext = createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);

export function useAddSheet() {
  const ctx = use(AddSheetContext);
  if (!ctx) throw new Error("useAddSheet must be used within AddSheetProvider");
  return ctx;
}

export function AddSheetProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <AddSheetContext value={{ open, setOpen }}>
      {children}
      <AddSheet open={open} onOpenChange={setOpen} />
    </AddSheetContext>
  );
}

function AddSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations("add");
  const tc = useTranslations("common");
  const locale = useLocale();
  const options = [
    {
      href: `/${locale}/import`,
      icon: FileUp,
      title: t("importTitle"),
      body: t("importBody"),
      tint: "oklch(0.7 0.13 235)",
    },
    {
      href: `/${locale}/connect-wallet`,
      icon: Wallet,
      title: t("walletTitle"),
      body: t("walletBody"),
      tint: "oklch(0.78 0.14 80)",
    },
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("title")} description={t("subtitle")} closeLabel={tc("close")}>
      <ul className="mt-2 grid gap-3">
        {options.map((o, i) => (
          <motion.li
            key={o.href}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 + i * 0.06, type: "spring", stiffness: 380, damping: 32 }}
          >
            <Link
              href={o.href}
              onClick={() => onOpenChange(false)}
              className="group flex items-start gap-4 rounded-3xl bg-surface p-5 hairline transition hover:bg-surface-2"
            >
              <span
                className="grid size-12 shrink-0 place-items-center rounded-2xl"
                style={{ background: `color-mix(in oklch, ${o.tint} 18%, transparent)`, color: o.tint }}
              >
                <o.icon className="size-5" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[15px] font-medium text-fg">
                  {o.title}
                  <ArrowUpRight className="size-4 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-fg-muted">{o.body}</span>
              </span>
            </Link>
          </motion.li>
        ))}
      </ul>
    </Sheet>
  );
}

"use client";

import { ArrowLeftRight, Check, Clock, Copy, FileWarning, Landmark, LoaderCircle, Repeat, Sparkles, Tag, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { CategoryPicker, type PickerCategory } from "@/components/finance/category-picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolveInboxItem } from "@/server/actions/finance";
import { useInboxText, type InboxItemData } from "./inbox-text";

const ICONS = {
  transfer_match: ArrowLeftRight,
  possible_duplicate: Copy,
  unknown_institution: Landmark,
  uncategorized: Tag,
  subscription_candidate: Repeat,
  stale_source: Clock,
  document_incomplete: FileWarning,
  account_confirmation: Landmark,
} as const;

type Decision = Parameters<typeof resolveInboxItem>[0]["decision"];

export function InboxView({
  items,
  categories,
  institutions,
}: {
  items: InboxItemData[];
  categories: PickerCategory[];
  institutions: { id: string; name: string; country: string | null }[];
}) {
  const t = useTranslations("inbox");
  const [resolved, setResolved] = useState<string[]>([]);
  const visible = items.filter((i) => !resolved.includes(i.id));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      {resolved.length > 0 ? (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[13px] text-positive">
          {t("resolvedCount", { count: resolved.length })} · {t("remembered")}
        </motion.p>
      ) : null}
      <AnimatePresence mode="popLayout" initial={false}>
        {visible.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-3 rounded-[2rem] bg-positive-soft px-6 py-16 text-center"
          >
            <span className="grid size-14 place-items-center rounded-full bg-bg-elevated text-positive shadow-soft">
              <Sparkles className="size-6" />
            </span>
            <h2 className="font-display text-[2rem] text-fg">{t("empty")}</h2>
            <p className="max-w-sm text-[14px] text-fg-muted">{t("emptyBody")}</p>
          </motion.div>
        ) : (
          visible.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              categories={categories}
              institutions={institutions}
              onResolved={() => setResolved((r) => [...r, item.id])}
            />
          ))
        )}
      </AnimatePresence>
    </div>
  );
}

function InboxCard({
  item,
  categories,
  institutions,
  onResolved,
}: {
  item: InboxItemData;
  categories: PickerCategory[];
  institutions: { id: string; name: string; country: string | null }[];
  onResolved: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const text = useInboxText();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const Icon = ICONS[item.kind as keyof typeof ICONS] ?? Sparkles;

  const act = (decision: Decision, extra: { categoryId?: string; institutionId?: string } = {}) =>
    startTransition(async () => {
      const r = await resolveInboxItem({ itemId: item.id, decision, ...extra });
      if (r.ok) {
        toast.success(decision === "dismiss" ? t("inbox.dismissed") : t("inbox.resolved"));
        onResolved();
      } else toast.error(t("common.somethingWrong"));
    });

  const direction = typeof item.payload.amount === "string" && item.payload.amount.startsWith("-") ? "out" : "in";

  return (
    <motion.article
      id={item.id}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.25 } }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className={cn("rounded-[1.6rem] bg-bg-elevated/85 p-5 shadow-soft hairline", pending && "opacity-70")}
    >
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
          <Icon className="size-[18px]" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-relaxed text-fg">{text(item)}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {item.kind === "transfer_match" ? (
              <>
                <Button size="sm" variant="primary" disabled={pending} onClick={() => act("transfer")}>
                  <Check />
                  {t("inbox.isTransfer")}
                </Button>
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => act("not_transfer")}>
                  {t("inbox.notTransfer")}
                </Button>
              </>
            ) : item.kind === "possible_duplicate" ? (
              <>
                <Button size="sm" variant="primary" disabled={pending} onClick={() => act("duplicate")}>
                  {t("inbox.markDuplicate")}
                </Button>
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => act("keep")}>
                  {t("inbox.keepBoth")}
                </Button>
              </>
            ) : item.kind === "subscription_candidate" ? (
              <>
                <Button size="sm" variant="primary" disabled={pending} onClick={() => act("yes")}>
                  {t("inbox.isSubscription")}
                </Button>
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => act("no")}>
                  {t("inbox.notSubscription")}
                </Button>
              </>
            ) : item.kind === "uncategorized" || item.kind === "unknown_institution" ? (
              <Button size="sm" variant="primary" disabled={pending} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {item.kind === "uncategorized" ? t("inbox.chooseCategory") : t("inbox.chooseInstitution")}
              </Button>
            ) : item.kind === "stale_source" ? (
              <Button size="sm" variant="primary" asChild>
                <Link href={`/${locale}/import`}>{t("inbox.importNow")}</Link>
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={pending} onClick={() => act("yes")}>
                {t("common.yes")}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("dismiss")}>
              <X />
              {t("inbox.dismiss")}
            </Button>
            {pending ? <LoaderCircle className="size-4 animate-spin text-fg-subtle" /> : null}
          </div>

          <AnimatePresence initial={false}>
            {expanded ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="pt-4">
                  {item.kind === "uncategorized" ? (
                    <CategoryPicker
                      categories={categories}
                      value={null}
                      direction={direction}
                      disabled={pending}
                      onSelect={(categoryId) => act("categorize", { categoryId })}
                    />
                  ) : (
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {institutions.map((inst) => (
                        <button
                          key={inst.id}
                          type="button"
                          disabled={pending}
                          onClick={() => act("institution", { institutionId: inst.id })}
                          className="flex items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        >
                          {inst.name}
                          <span className="text-[11px] text-fg-subtle">{inst.country}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </motion.article>
  );
}

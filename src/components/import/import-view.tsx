"use client";

import { ArrowRight, CircleCheck, CircleX, FileSpreadsheet, FileText, LoaderCircle, ShieldCheck, Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { cn } from "@/lib/utils";
import { countOpenInbox } from "@/server/actions/finance";

const ACCEPT = ".pdf,.csv,.ofx,.qfx,.xlsx,.txt";
const STAGES = [
  "validating",
  "stored",
  "detecting",
  "identifying",
  "extracting",
  "normalizing",
  "deduplicating",
  "categorizing",
  "reconciling",
  "recurring",
  "persisting",
  "completed",
] as const;

interface JobStats {
  transactionsOrganized?: number;
  duplicatesSkipped?: number;
  accountsIdentified?: number;
  recurringDetected?: number;
  reviewItems?: number;
  warnings?: number;
  institution?: { slug?: string; name?: string } | null;
}

interface QueueItem {
  key: string;
  file: File;
  state: "queued" | "uploading" | "processing" | "completed" | "failed" | "already";
  jobId?: string;
  stage?: string;
  progress: number;
  stats?: JobStats;
  error?: string;
}

const terminal = (s: QueueItem["state"]) => s === "completed" || s === "failed" || s === "already";

export function ImportView({ maxMb }: { maxMb: number }) {
  const t = useTranslations("import");
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [openReview, setOpenReview] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((key: string, p: Partial<QueueItem>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const errorText = useCallback(
    (code?: string) =>
      code === "unsupported"
        ? t("errorUnsupported")
        : code === "too_large"
          ? t("errorTooLarge", { max: maxMb })
          : code === "empty"
            ? t("errorEmpty")
            : code === "unreadable"
              ? t("errorUnreadable")
              : t("errorGeneric"),
    [maxMb, t],
  );

  const poll = useCallback(
    async (key: string, jobId: string) => {
      for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const res = await fetch(`/api/import/${jobId}`, { cache: "no-store" });
        if (!res.ok) continue;
        const job = (await res.json()) as { status: string; stage: string; progress: number; stats: JobStats; errorCode?: string | null };
        if (job.status === "failed") {
          patch(key, { state: "failed", error: errorText(job.errorCode ?? undefined), stage: job.stage, progress: job.progress });
          return;
        }
        if (job.status === "completed" || job.status === "needs_review") {
          patch(key, { state: "completed", stage: "completed", progress: 100, stats: job.stats });
          // Per-job counts overlap when files import concurrently: show the real open total.
          setOpenReview(await countOpenInbox());
          router.refresh(); // The list of imported files below.
          return;
        }
        patch(key, { state: "processing", stage: job.stage, progress: job.progress });
      }
      patch(key, { state: "failed", error: t("errorWaitExpired") });
    },
    [errorText, patch, router, t],
  );

  const upload = useCallback(
    async (item: QueueItem) => {
      patch(item.key, { state: "uploading", progress: 3 });
      try {
        const body = new FormData();
        body.append("file", item.file);
        const res = await fetch("/api/import", { method: "POST", body });
        const json = (await res.json().catch(() => ({}))) as { jobId?: string; alreadyImported?: boolean; error?: string };
        if (!res.ok || !json.jobId) {
          patch(item.key, { state: "failed", error: errorText(json.error) });
          return;
        }
        if (json.alreadyImported) {
          patch(item.key, { state: "already", jobId: json.jobId, progress: 100 });
          return;
        }
        patch(item.key, { state: "processing", jobId: json.jobId, stage: "received", progress: 5 });
        await poll(item.key, json.jobId);
      } catch {
        patch(item.key, { state: "failed", error: t("errorGeneric") });
      }
    },
    [errorText, patch, poll, t],
  );

  // Two uploads at a time; workers drain a shared queue and are started from events.
  const pending = useRef<QueueItem[]>([]);
  const active = useRef(0);
  const worker = useCallback(async () => {
    while (pending.current.length > 0) {
      const item = pending.current.shift()!;
      await upload(item);
    }
    active.current--;
  }, [upload]);

  const addFiles = (files: FileList | File[]) => {
    const next: QueueItem[] = [...files].map((file) => ({
      key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      progress: 0,
      ...(file.size === 0
        ? { state: "failed" as const, error: t("errorEmpty") }
        : file.size > maxMb * 1024 * 1024
          ? { state: "failed" as const, error: t("errorTooLarge", { max: maxMb }) }
          : { state: "queued" as const }),
    }));
    setItems((list) => [...list, ...next]);
    pending.current.push(...next.filter((i) => i.state === "queued"));
    while (active.current < 2 && pending.current.length > 0) {
      active.current++;
      void worker();
    }
  };

  const done = items.length > 0 && items.every((i) => terminal(i.state));
  const totals = items.reduce(
    (acc, i) => {
      acc.organized += i.stats?.transactionsOrganized ?? 0;
      acc.accounts += i.stats?.accountsIdentified ?? 0;
      acc.recurring += i.stats?.recurringDetected ?? 0;
      acc.review += i.stats?.reviewItems ?? 0;
      acc.skipped += i.stats?.duplicatesSkipped ?? 0;
      return acc;
    },
    { organized: 0, accounts: 0, recurring: 0, review: 0, skipped: 0 },
  );

  return (
    <div className="flex flex-col gap-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "relative flex flex-col items-center justify-center gap-4 overflow-hidden rounded-[2rem] border-2 border-dashed px-6 py-14 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-bg-elevated/60",
        )}
      >
        <motion.span
          animate={dragging ? { scale: 1.08, y: -4 } : { scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="grid size-16 place-items-center rounded-full bg-bg-elevated text-accent shadow-soft"
        >
          <Upload className="size-7" />
        </motion.span>
        <div>
          <p className="font-display text-[1.9rem] leading-tight text-fg">{t("dropTitle")}</p>
          <p className="mt-1 text-[14px] text-fg-muted">{t("dropBody", { max: maxMb })}</p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-fg px-5 text-[14px] font-medium text-bg shadow-soft transition hover:opacity-90"
        >
          {t("choose")}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          aria-label={t("choose")}
          data-testid="import-input"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="flex items-center gap-1.5 text-[12px] text-fg-subtle">
          <ShieldCheck className="size-3.5" />
          {t("privacy")}
        </p>
      </div>

      <ul className="flex flex-col gap-3" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <QueueRow key={item.key} item={item} />
          ))}
        </AnimatePresence>
      </ul>

      <AnimatePresence>
        {done && totals.organized + totals.skipped > 0 ? (
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
            className="rounded-[2rem] bg-bg-elevated/90 p-7 shadow-float hairline"
            data-testid="import-summary"
          >
            <p className="font-display text-[2.2rem] leading-none text-fg">{t("completedTitle")}</p>
            <ul className="mt-5 grid grid-cols-1 gap-2 text-[15px] text-fg sm:grid-cols-2">
              {[
                t("organized", { count: totals.organized }),
                t("accountsIdentified", { count: totals.accounts }),
                t("recurringDetected", { count: totals.recurring }),
                t("reviewItems", { count: openReview ?? totals.review }),
                ...(totals.skipped > 0 ? [t("duplicatesSkipped", { count: totals.skipped })] : []),
              ].map((line, i) => (
                <motion.li key={line} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.08 }} className="flex items-center gap-2">
                  <CircleCheck className="size-4 text-positive" />
                  {line}
                </motion.li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-2">
              {(openReview ?? totals.review) > 0 ? (
                <Link href={`/${locale}/inbox`} className="inline-flex h-10 items-center gap-2 rounded-full bg-fg px-5 text-[14px] font-medium text-bg">
                  {t("reviewNow")}
                  <ArrowRight className="size-4" />
                </Link>
              ) : null}
              <Link href={`/${locale}/activity`} className="inline-flex h-10 items-center rounded-full bg-surface-2 px-5 text-[14px] font-medium text-fg hairline">
                {t("viewActivity")}
              </Link>
              <button type="button" onClick={() => setItems([])} className="inline-flex h-10 items-center rounded-full px-5 text-[14px] text-fg-muted hover:text-fg">
                {t("importMore")}
              </button>
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  const t = useTranslations("import");
  const isSheet = /\.(csv|xlsx)$/i.test(item.file.name);
  const Icon = isSheet ? FileSpreadsheet : FileText;
  const stageLabel =
    item.state === "queued"
      ? t("queued")
      : item.state === "uploading"
        ? t("uploading")
        : item.state === "already"
          ? t("alreadyImported")
          : item.state === "failed"
            ? (item.error ?? t("failed"))
            : STAGES.includes((item.stage ?? "") as (typeof STAGES)[number]) || item.stage === "received"
              ? t(`stage_${item.stage}` as "stage_received")
              : t("stage_received");
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex items-center gap-4 rounded-[1.5rem] bg-bg-elevated/85 p-4 hairline"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-fg-muted">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-[14.5px] font-medium text-fg">{item.file.name}</p>
          {item.state === "completed" ? (
            <CircleCheck className="size-5 shrink-0 text-positive" />
          ) : item.state === "failed" ? (
            <CircleX className="size-5 shrink-0 text-negative" />
          ) : item.state === "already" ? (
            <CircleCheck className="size-5 shrink-0 text-fg-subtle" />
          ) : (
            <LoaderCircle className="size-5 shrink-0 animate-spin text-accent" />
          )}
        </div>
        <p className={cn("mt-0.5 text-[12.5px]", item.state === "failed" ? "text-negative" : "text-fg-subtle")}>
          {item.state === "completed" && item.stats
            ? [
                item.stats.institution?.name,
                t("organized", { count: item.stats.transactionsOrganized ?? 0 }),
                (item.stats.warnings ?? 0) > 0 ? t("warnings", { count: item.stats.warnings ?? 0 }) : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : stageLabel}
        </p>
        {!terminal(item.state) ? (
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <motion.div
              className="h-full rounded-full"
              style={{ background: "linear-gradient(90deg, oklch(0.72 0.15 165), oklch(0.62 0.15 240), oklch(0.58 0.2 290))" }}
              animate={{ width: `${Math.max(item.progress, 4)}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 24 }}
            />
          </div>
        ) : null}
      </div>
    </motion.li>
  );
}

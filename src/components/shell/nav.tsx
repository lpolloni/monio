"use client";

import { ArrowDownUp, ChartSpline, Compass, House, Plus } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { cn } from "@/lib/utils";
import { useAddSheet } from "./add-sheet";

const ITEMS = [
  { segment: "", key: "home", icon: House },
  { segment: "explore", key: "explore", icon: Compass },
  { segment: "activity", key: "activity", icon: ArrowDownUp },
  { segment: "insights", key: "insights", icon: ChartSpline },
] as const;

function useActiveSegment(): string {
  const pathname = usePathname();
  return pathname.split("/")[2] ?? "";
}

/**
 * The pathname is unknown while prerendering routes with request-time params
 * (e.g. /explore/[accountId]), so reading it must sit under Suspense. The
 * fallback is the same navigation without an active item: links work at once
 * and only the highlight streams in.
 */
function withActiveSegment(View: (props: { active: string | null }) => ReactNode) {
  function Resolved() {
    return <View active={useActiveSegment()} />;
  }
  return function Navigation() {
    return (
      <Suspense fallback={<View active={null} />}>
        <Resolved />
      </Suspense>
    );
  };
}

/** Desktop/tablet: floating glass pill with a gliding active indicator. */
export const TopNav = withActiveSegment(TopNavView);

function TopNavView({ active }: { active: string | null }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  return (
    <nav aria-label={t("mainNavigation")} className="glass hidden rounded-full p-1 hairline shadow-soft md:flex">
      {ITEMS.map(({ segment, key, icon: Icon }) => {
        const isActive = active === segment;
        return (
          <Link
            key={key}
            href={`/${locale}${segment ? `/${segment}` : ""}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative z-0 flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium transition-colors",
              isActive ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {isActive ? (
              <motion.span
                layoutId="topnav-active"
                className="absolute inset-0 -z-10 rounded-full bg-bg-elevated shadow-soft hairline"
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
              />
            ) : null}
            <Icon className="size-4" strokeWidth={1.8} />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}

/** Phones: thumb-reachable tab bar with the ADD action in the middle. */
export const BottomNav = withActiveSegment(BottomNavView);

function BottomNavView({ active }: { active: string | null }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const { setOpen } = useAddSheet();
  const left = ITEMS.slice(0, 2);
  const right = ITEMS.slice(2);
  const renderItem = ({ segment, key, icon: Icon }: (typeof ITEMS)[number]) => {
    const isActive = active === segment;
    return (
      <Link
        key={key}
        href={`/${locale}${segment ? `/${segment}` : ""}`}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex flex-1 flex-col items-center gap-1 py-1.5 text-[10.5px] font-medium transition-colors",
          isActive ? "text-fg" : "text-fg-subtle",
        )}
      >
        <span className="relative grid h-7 w-12 place-items-center">
          {isActive ? (
            <motion.span
              layoutId="bottomnav-active"
              className="absolute inset-0 rounded-full bg-accent-soft"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            />
          ) : null}
          <Icon className="relative size-[19px]" strokeWidth={isActive ? 2.1 : 1.8} />
        </span>
        {t(key)}
      </Link>
    );
  };
  return (
    <nav
      aria-label={t("mainNavigation")}
      className="glass fixed inset-x-3 bottom-3 z-40 flex items-center rounded-[1.6rem] px-2 pt-1.5 pb-1.5 hairline shadow-float md:hidden"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      {left.map(renderItem)}
      <div className="flex flex-1 justify-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("add")}
          className="grid size-12 -translate-y-3 place-items-center rounded-full text-white shadow-float transition active:scale-95"
          style={{ background: "linear-gradient(135deg, oklch(0.72 0.15 165), oklch(0.62 0.15 240) 55%, oklch(0.58 0.2 290))" }}
        >
          <Plus className="size-6" strokeWidth={2.2} />
        </button>
      </div>
      {right.map(renderItem)}
    </nav>
  );
}

export function AddButton() {
  const t = useTranslations("nav");
  const { setOpen } = useAddSheet();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="hidden h-10 items-center gap-2 rounded-full pl-3 pr-4 text-sm font-medium text-white shadow-soft transition hover:brightness-110 active:scale-[0.97] md:inline-flex"
      style={{ background: "linear-gradient(135deg, oklch(0.7 0.15 165), oklch(0.6 0.15 240) 55%, oklch(0.56 0.2 290))" }}
    >
      <Plus className="size-4" strokeWidth={2.4} />
      {t("add")}
    </button>
  );
}

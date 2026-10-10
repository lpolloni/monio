"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { useLocale, useTranslations } from "use-intl";
import type { AssetGroup } from "@/domain/accounts/classification";
import { formatMoney, freshnessOf, type Freshness } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ConstellationNode {
  key: string;
  name: string;
  short: string;
  color: string | null;
  value: string;
  assets: string;
  liabilities: string;
  lastUpdated: string | null;
  groups: AssetGroup[];
  isBusiness: boolean;
}

interface Props {
  nodes: ConstellationNode[];
  netWorth: string;
  currency: string;
  groups: Record<AssetGroup, string>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  now: string;
}

const GROUP_ORDER: AssetGroup[] = ["cash", "investments", "crypto", "other"];
const GROUP_VAR: Record<AssetGroup, string> = {
  cash: "var(--group-cash)",
  investments: "var(--group-investments)",
  crypto: "var(--group-crypto)",
  liabilities: "var(--group-liabilities)",
  other: "var(--group-other)",
};

const FRESHNESS_COLOR: Record<Freshness, string> = {
  fresh: "var(--positive)",
  aging: "var(--warning)",
  stale: "var(--negative)",
  unknown: "var(--fg-subtle)",
};

function abs(v: string): number {
  // Geometry only (node sizes / ring proportions) — never used for money math.
  return Math.abs(Number(v)) || 0;
}

/**
 * The Home centerpiece: the consolidated net worth at the core, a distribution
 * ring around it, and each institution as a body on its orbit, sized by weight.
 * Nodes are real buttons (keyboard + screen reader friendly); an equivalent list
 * view is available next to it.
 */
export function WealthConstellation({ nodes, netWorth, currency, groups, selected, onSelect, now }: Props) {
  const t = useTranslations("home");
  const locale = useLocale();
  const reduce = useReducedMotion();
  const nowDate = useMemo(() => new Date(now), [now]);

  const layout = useMemo(() => {
    const weights = nodes.map((n) => abs(n.assets) + abs(n.liabilities));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const count = nodes.length;
    const twoOrbits = count > 7;
    return nodes.map((node, i) => {
      // Start top-left and walk clockwise; alternate orbits when crowded.
      const angle = -125 + (360 / Math.max(count, 1)) * i;
      const radius = twoOrbits ? (i % 2 === 0 ? 41 : 31.5) : 39;
      const rad = (angle * Math.PI) / 180;
      const share = weights[i]! / total;
      const size = Math.round(46 + Math.sqrt(share) * 58); // px, 46..~104
      // Rounded so server and client render identical inline styles.
      return {
        node,
        x: Math.round((50 + Math.cos(rad) * radius) * 100) / 100,
        y: Math.round((50 + Math.sin(rad) * radius) * 100) / 100,
        size,
        share,
        freshness: freshnessOf(node.lastUpdated, nowDate),
      };
    });
  }, [nodes, nowDate]);

  // Distribution ring around the core.
  const ring = useMemo(() => {
    const values = GROUP_ORDER.map((g) => ({ group: g, value: abs(groups[g]) }));
    const assetsTotal = values.reduce((a, b) => a + b.value, 0);
    const circumference = 2 * Math.PI * 21;
    const gap = 0.9;
    const arcs = values
      .filter((v) => v.value > 0)
      .reduce<{ group: AssetGroup; len: number; offset: number; circumference: number }[]>((acc, v) => {
        const prev = acc[acc.length - 1];
        const offset = prev ? prev.offset + prev.len + gap : 0;
        acc.push({ group: v.group, len: Math.max(0, (v.value / (assetsTotal || 1)) * circumference - gap), offset, circumference });
        return acc;
      }, []);
    const liabilityShare = assetsTotal ? Math.min(1, abs(groups.liabilities) / assetsTotal) : 0;
    return { arcs, liabilityShare, circumference: 2 * Math.PI * 17.2 };
  }, [groups]);

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[600px] select-none" role="group" aria-label={t("constellationLabel")}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <defs>
          <radialGradient id="core-fill" cx="40%" cy="35%">
            <stop offset="0%" stopColor="var(--bg-elevated)" />
            <stop offset="100%" stopColor="var(--surface)" />
          </radialGradient>
        </defs>

        {/* Orbits */}
        {[39, 31.5, 41].slice(0, layout.length > 7 ? 3 : 1).map((r, i) => (
          <motion.circle
            key={r}
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth="0.18"
            strokeDasharray={i === 0 ? "0.4 1.1" : undefined}
            initial={reduce ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
          />
        ))}

        {/* Connections */}
        {layout.map(({ node, x, y, freshness }, i) => {
          const active = selected === node.key;
          const dimmed = selected !== null && !active;
          return (
            <motion.line
              key={node.key}
              x1="50"
              y1="50"
              x2={x}
              y2={y}
              stroke={node.color ?? "var(--fg-subtle)"}
              strokeWidth={active ? 0.45 : 0.22}
              strokeDasharray={freshness === "stale" ? "0.8 0.8" : undefined}
              initial={reduce ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: dimmed ? 0.12 : active ? 0.9 : 0.4 }}
              transition={{ duration: 0.9, delay: reduce ? 0 : 0.25 + i * 0.05, ease: [0.16, 1, 0.3, 1] }}
            />
          );
        })}

        {/* Core */}
        <circle cx="50" cy="50" r="23.5" fill="url(#core-fill)" stroke="var(--border)" strokeWidth="0.2" />
        {/* Asset distribution ring */}
        <g transform="rotate(-90 50 50)">
          <circle cx="50" cy="50" r="21" fill="none" stroke="var(--surface-2)" strokeWidth="1.3" />
          {ring.arcs.map((arc, i) => (
            <motion.circle
              key={arc.group}
              cx="50"
              cy="50"
              r="21"
              fill="none"
              stroke={GROUP_VAR[arc.group]}
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeDasharray={`${arc.len} ${arc.circumference - arc.len}`}
              initial={reduce ? false : { strokeDashoffset: arc.circumference, opacity: 0 }}
              animate={{ strokeDashoffset: -arc.offset, opacity: 1 }}
              transition={{ duration: 1.1, delay: reduce ? 0 : 0.15 + i * 0.12, ease: [0.16, 1, 0.3, 1] }}
            />
          ))}
          {ring.liabilityShare > 0 ? (
            <motion.circle
              cx="50"
              cy="50"
              r="17.2"
              fill="none"
              stroke={GROUP_VAR.liabilities}
              strokeWidth="0.55"
              strokeLinecap="round"
              strokeDasharray={`${ring.liabilityShare * ring.circumference} ${ring.circumference}`}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 0.85 }}
              transition={{ duration: 0.8, delay: 0.6 }}
            />
          ) : null}
        </g>
      </svg>

      {/* Core label */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <motion.div
          className="flex max-w-[38%] flex-col items-center text-center"
          initial={reduce ? false : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-fg-subtle sm:text-[11px]">{t("netWorth")}</span>
          <span className="mt-1 font-display text-[1.65rem] leading-none text-fg tabular sm:text-[2.35rem]">
            {formatMoney(netWorth, currency, locale, { compact: true })}
          </span>
        </motion.div>
      </div>

      {/* Institution bodies */}
      {layout.map(({ node, x, y, size, freshness }, i) => {
        const active = selected === node.key;
        const dimmed = selected !== null && !active;
        const color = node.color ?? "var(--fg-subtle)";
        const negative = abs(node.liabilities) > abs(node.assets);
        return (
          <motion.button
            key={node.key}
            type="button"
            onClick={() => onSelect(active ? null : node.key)}
            aria-pressed={active}
            aria-label={`${node.name}: ${formatMoney(node.value, currency, locale)}`}
            className="group absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 rounded-full outline-none"
            style={{ left: `${x}%`, top: `${y}%`, ["--node" as string]: `${size}px` }}
            initial={reduce ? false : { opacity: 0, scale: 0.3, left: "50%", top: "50%" }}
            animate={{ opacity: dimmed ? 0.38 : 1, scale: active ? 1.08 : 1, left: `${x}%`, top: `${y}%` }}
            whileHover={{ scale: active ? 1.08 : 1.05 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: "spring", stiffness: 140, damping: 18, delay: reduce ? 0 : 0.2 + i * 0.06 }}
          >
            <motion.span
              layoutId={`inst-${node.key}`}
              className={cn(
                "relative grid place-items-center rounded-full text-[12px] font-semibold tracking-tight text-fg shadow-soft transition-shadow sm:text-[13px]",
                "size-[calc(var(--node)*0.72)] sm:size-[var(--node)]",
                active && "shadow-float",
              )}
              style={{
                background: `radial-gradient(circle at 35% 30%, color-mix(in oklch, ${color} 32%, var(--bg-elevated)), color-mix(in oklch, ${color} 14%, var(--bg-elevated)))`,
                boxShadow: `inset 0 0 0 ${active ? 2 : 1}px color-mix(in oklch, ${negative ? "var(--negative)" : color} ${active ? 85 : 45}%, transparent)`,
              }}
            >
              {node.short}
              <span
                className="absolute top-[8%] right-[8%] size-2 rounded-full ring-2 ring-bg"
                style={{ background: FRESHNESS_COLOR[freshness] }}
                aria-hidden
              />
            </motion.span>
            <span className="hidden max-w-[9rem] flex-col items-center sm:flex">
              <span className="truncate text-[11.5px] font-medium text-fg">{node.name}</span>
              <span className={cn("text-[11px] tabular", negative ? "text-negative" : "text-fg-subtle")}>
                {formatMoney(node.value, currency, locale, { compact: true })}
              </span>
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

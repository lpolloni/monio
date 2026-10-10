"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

const NODES = [
  { angle: -150, r: 150, size: 34, hue: 300, label: "Nu" },
  { angle: -95, r: 176, size: 26, hue: 85, label: "XP" },
  { angle: -35, r: 158, size: 30, hue: 165, label: "N26" },
  { angle: 25, r: 172, size: 22, hue: 260, label: "R" },
  { angle: 85, r: 150, size: 28, hue: 25, label: "MPS" },
  { angle: 140, r: 168, size: 24, hue: 235, label: "BBVA" },
  { angle: 190, r: 176, size: 20, hue: 75, label: "₿" },
];

/** Decorative preview of the Home constellation (static after its entrance). */
export function OrbitIllustration({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className={cn("relative aspect-square w-full", className)} aria-hidden>
      <svg viewBox="-220 -220 440 440" className="absolute inset-0 size-full">
        <defs>
          <radialGradient id="core-g">
            <stop offset="0%" stopColor="oklch(0.86 0.13 165)" />
            <stop offset="60%" stopColor="oklch(0.72 0.13 235)" />
            <stop offset="100%" stopColor="oklch(0.6 0.18 290)" />
          </radialGradient>
        </defs>
        {[110, 160, 200].map((r, i) => (
          <motion.circle
            key={r}
            r={r}
            fill="none"
            stroke="currentColor"
            className="text-border-strong"
            strokeDasharray={i === 1 ? "2 6" : undefined}
            initial={reduce ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1.4, delay: 0.1 * i, ease: [0.16, 1, 0.3, 1] }}
          />
        ))}
        {NODES.map((n, i) => {
          const rad = (n.angle * Math.PI) / 180;
          const x = Math.cos(rad) * n.r;
          const y = Math.sin(rad) * n.r;
          return (
            <motion.g
              key={n.label}
              initial={reduce ? false : { opacity: 0, x: 0, y: 0, scale: 0.4 }}
              animate={{ opacity: 1, x, y, scale: 1 }}
              transition={{ type: "spring", stiffness: 90, damping: 16, delay: 0.35 + i * 0.07 }}
            >
              <line x1={0} y1={0} x2={-x} y2={-y} stroke={`oklch(0.7 0.12 ${n.hue} / 0.35)`} strokeWidth={1} />
              <circle r={n.size} fill={`oklch(0.7 0.13 ${n.hue} / 0.16)`} stroke={`oklch(0.7 0.13 ${n.hue} / 0.6)`} />
              <text textAnchor="middle" dy="0.35em" className="fill-fg font-sans text-[11px] font-semibold">
                {n.label}
              </text>
            </motion.g>
          );
        })}
        <motion.circle
          r={74}
          fill="url(#core-g)"
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 80, damping: 14 }}
        />
        <circle r={74} fill="none" stroke="white" strokeOpacity={0.35} />
      </svg>
    </div>
  );
}

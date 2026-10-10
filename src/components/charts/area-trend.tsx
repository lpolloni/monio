"use client";

import { useId } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLocale } from "use-intl";
import { formatDate, formatMoney } from "@/lib/format";

export interface TrendPoint {
  date: string;
  /** Plotted value — parsed from a decimal string for drawing only. */
  value: number;
  label: string;
  secondary?: number;
  secondaryLabel?: string;
}

interface Props {
  data: TrendPoint[];
  currency: string;
  color?: string;
  secondaryColor?: string;
  secondaryName?: string;
  height?: number;
  primaryName?: string;
}

/**
 * Smooth area chart for money over time. Values are drawn from numbers but every
 * label (axis, tooltip) shows the exact decimal string formatted for the locale.
 */
export function AreaTrend({ data, currency, color = "var(--accent)", secondaryColor = "var(--fg-subtle)", secondaryName, primaryName, height = 260 }: Props) {
  const locale = useLocale();
  const id = useId().replace(/:/g, "");
  const hasSecondary = data.some((d) => d.secondary !== undefined);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tick={{ fill: "var(--fg-subtle)", fontSize: 11 }}
            tickFormatter={(d: string) => formatDate(d, locale, "dayMonth")}
          />
          <YAxis
            width={64}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--fg-subtle)", fontSize: 11 }}
            tickFormatter={(v: number) => formatMoney(String(v), currency, locale, { compact: true })}
          />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)" }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as TrendPoint | undefined;
              if (!active || !p) return null;
              return (
                <div className="rounded-2xl bg-bg-elevated px-3.5 py-2.5 text-[12.5px] shadow-float hairline">
                  <p className="text-fg-subtle">{formatDate(p.date, locale, "medium")}</p>
                  <p className="mt-0.5 font-medium text-fg tabular">
                    {primaryName ? `${primaryName}: ` : ""}
                    {p.label}
                  </p>
                  {p.secondaryLabel ? (
                    <p className="text-fg-muted tabular">
                      {secondaryName ? `${secondaryName}: ` : ""}
                      {p.secondaryLabel}
                    </p>
                  ) : null}
                </div>
              );
            }}
          />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#fill-${id})`} animationDuration={900} />
          {hasSecondary ? (
            <Line type="monotone" dataKey="secondary" stroke={secondaryColor} strokeWidth={1.5} strokeDasharray="4 4" dot={false} animationDuration={900} />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

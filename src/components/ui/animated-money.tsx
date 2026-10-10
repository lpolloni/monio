"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { formatMoney, type MoneyFormatOptions } from "@/lib/format";
import type { Locale } from "@/i18n/config";

interface AnimatedMoneyProps extends MoneyFormatOptions {
  amount: string;
  currency: string;
  locale: Locale;
  className?: string;
}

/**
 * Animates between values when the amount or display currency changes. The
 * tween is cosmetic only (interpolated numbers are never used for math) and the
 * final frame always shows the exact decimal value.
 */
export function AnimatedMoney({ amount, currency, locale, className, ...options }: AnimatedMoneyProps) {
  const reduce = useReducedMotion();
  const exact = formatMoney(amount, currency, locale, options);
  const [display, setDisplay] = useState(exact);
  const previous = useRef<{ amount: string; currency: string } | null>(null);

  useEffect(() => {
    const prev = previous.current;
    previous.current = { amount, currency };
    if (reduce || !prev) {
      setDisplay(exact);
      return;
    }
    const from = prev.currency === currency ? Number(prev.amount) : 0;
    const to = Number(amount);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
      setDisplay(exact);
      return;
    }
    const controls = animate(from, to, {
      duration: 0.9,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(formatMoney(v.toFixed(8), currency, locale, options)),
      onComplete: () => setDisplay(exact),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, currency, locale, reduce]);

  return (
    <span className={className}>
      <span className="sr-only">{exact}</span>
      <span aria-hidden className="tabular">
        {display}
      </span>
    </span>
  );
}

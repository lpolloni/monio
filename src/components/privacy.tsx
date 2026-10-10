"use client";

import { Eye, EyeOff } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

/**
 * Privacy mode: amounts stay on the page but cannot be read (for a shared
 * screen, or someone looking over a shoulder). Off by default; the choice is
 * kept in this browser.
 *
 * Two mechanisms, so that nothing sensitive shows even before the page is
 * interactive:
 *  - `html[data-privacy="hidden"]` blurs every numeric element (`.tabular`,
 *    `.sensitive`, chart axis values) in CSS. `PRIVACY_SCRIPT` sets the
 *    attribute before the first paint.
 *  - amounts written inside a sentence are replaced by dots (`mask`), and those
 *    sentences (`.sensitive-prose`) stay invisible until that has happened.
 */
const STORAGE_KEY = "monio-privacy";

/** Runs before paint: applies the stored choice to <html>. */
export const PRIVACY_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})==="hidden")document.documentElement.dataset.privacy="hidden"}catch(e){}`;

interface Privacy {
  hidden: boolean;
  toggle: () => void;
  /** The text with its figures replaced by dots when values are hidden. */
  mask: (text: string) => string;
}

const PrivacyContext = createContext<Privacy>({ hidden: false, toggle: () => {}, mask: (text) => text });

/** "R$ 1.234,56" → "R$ •••••": the currency stays, the figure does not. */
export function maskFigures(text: string): string {
  return text.replace(/[-+−]?\d[\d.,\s]*\d|[-+−]?\d/g, "•••••");
}

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);

  // The stored choice is only known in the browser.
  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(STORAGE_KEY) === "hidden";
    } catch {
      // Storage unavailable: values stay visible.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHidden(stored);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (hidden) root.dataset.privacy = "hidden";
    else delete root.dataset.privacy;
    // Sentences are masked from here on: they may be shown.
    root.dataset.privacyReady = "true";
  }, [hidden]);

  const toggle = useCallback(() => {
    setHidden((current) => {
      try {
        if (current) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, "hidden");
      } catch {
        // Storage unavailable: the choice lasts for this visit.
      }
      return !current;
    });
  }, []);

  const value = useMemo<Privacy>(() => ({ hidden, toggle, mask: (text) => (hidden ? maskFigures(text) : text) }), [hidden, toggle]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy(): Privacy {
  return useContext(PrivacyContext);
}

/** Header button that hides or shows every amount. */
export function PrivacyToggle() {
  const t = useTranslations("nav");
  const { hidden, toggle } = usePrivacy();
  const label = hidden ? t("showValues") : t("hideValues");
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={label}
      title={label}
      className="grid size-10 place-items-center rounded-full bg-surface-2 text-fg-muted hairline transition hover:text-fg"
    >
      {hidden ? <EyeOff className="size-[18px]" strokeWidth={1.8} /> : <Eye className="size-[18px]" strokeWidth={1.8} />}
    </button>
  );
}

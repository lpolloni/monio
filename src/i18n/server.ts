import "server-only";
import { locale as rootLocale } from "next/root-params";
import { createTranslator } from "use-intl/core";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";
import { getMessages } from "./messages";

/** Locale of the current route (the `[locale]` root segment). */
export async function getLocale(): Promise<Locale> {
  const value = await rootLocale();
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Server-side translator for the current route's locale. */
export async function getT() {
  const locale = await getLocale();
  return createTranslator({ locale, messages: getMessages(locale) });
}

export type ServerTranslator = Awaited<ReturnType<typeof getT>>;

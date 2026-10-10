import type { Locale } from "../config";
import en, { type Messages } from "./en";
import it from "./it";
import pt from "./pt";

const MESSAGES: Record<Locale, Messages> = { en, pt, it };

export function getMessages(locale: Locale): Messages {
  return MESSAGES[locale];
}

export type { Messages };

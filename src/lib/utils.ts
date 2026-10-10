import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Two-letter monogram for institutions/merchants without a logo. */
export function monogram(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (/^[A-Z0-9]{2,4}$/.test(cleaned)) return cleaned.slice(0, 3);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const w = words[0]!;
    return /\d/.test(w) ? w.slice(0, 3).toUpperCase() : w.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Category color derived from its hue so it adapts to both themes. */
export function hueColor(hue: number, alpha = 1): string {
  return `oklch(0.7 0.13 ${hue} / ${alpha})`;
}

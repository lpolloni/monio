import {
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  Briefcase,
  Building,
  ChartLine,
  CircleDashed,
  CirclePlus,
  Clapperboard,
  CreditCard,
  Fuel,
  Gift,
  GraduationCap,
  HandCoins,
  HeartPulse,
  House,
  Landmark,
  PenTool,
  Percent,
  Plane,
  Receipt,
  Repeat,
  Repeat2,
  ShieldCheck,
  ShoppingBag,
  ShoppingBasket,
  Sparkles,
  TramFront,
  TrendingUp,
  Undo2,
  UtensilsCrossed,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";
import { getCategory } from "@/domain/categories/catalog";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  ShoppingBasket,
  UtensilsCrossed,
  TramFront,
  Fuel,
  House,
  Zap,
  Wifi,
  Repeat,
  ShoppingBag,
  HeartPulse,
  Plane,
  Clapperboard,
  GraduationCap,
  HandCoins,
  Sparkles,
  ShieldCheck,
  Landmark,
  Receipt,
  Gift,
  Briefcase,
  Banknote,
  CircleDashed,
  BadgeDollarSign,
  Building,
  PenTool,
  Percent,
  TrendingUp,
  Undo2,
  CirclePlus,
  ArrowLeftRight,
  CreditCard,
  ChartLine,
  Repeat2,
};

export function categoryHue(slug: string | null | undefined): number {
  return (slug ? getCategory(slug)?.hue : undefined) ?? 260;
}

export function CategoryIcon({ slug, className, size = "md" }: { slug: string | null | undefined; className?: string; size?: "sm" | "md" | "lg" }) {
  const def = slug ? getCategory(slug) : undefined;
  const icon = (def && ICONS[def.icon]) || CircleDashed;
  const hue = def?.hue ?? 260;
  const dims = size === "sm" ? "size-8 rounded-xl" : size === "lg" ? "size-12 rounded-2xl" : "size-10 rounded-[0.9rem]";
  return (
    <span
      className={cn("grid shrink-0 place-items-center", dims, className)}
      style={{ background: `oklch(0.72 0.12 ${hue} / 0.16)`, color: `oklch(0.62 0.14 ${hue})` }}
      aria-hidden
    >
      {createElement(icon, { className: size === "sm" ? "size-4" : "size-[18px]", strokeWidth: 1.8 })}
    </span>
  );
}

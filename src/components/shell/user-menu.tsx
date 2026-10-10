"use client";

import { Check, Languages, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { DropdownMenu } from "radix-ui";
import { useTransition } from "react";
import { useLocale, useTranslations } from "use-intl";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";
import { cn, monogram } from "@/lib/utils";
import { setLocalePreference, signOut } from "@/server/actions/preferences";

const itemClass =
  "flex cursor-pointer select-none items-center gap-3 rounded-xl px-3 py-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-2";

export function UserMenu({ name, email }: { name: string; email: string | null }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [pending, startTransition] = useTransition();

  const switchLocale = (next: Locale) => {
    startTransition(async () => {
      await setLocalePreference(next);
      const rest = pathname.split("/").slice(2).join("/");
      router.replace(`/${next}${rest ? `/${rest}` : ""}`);
    });
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="grid size-10 place-items-center rounded-full bg-surface-2 text-[13px] font-semibold text-fg hairline transition hover:shadow-soft data-[state=open]:shadow-soft"
        aria-label={t("menu")}
      >
        {monogram(name)}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={10}
          className="z-50 w-64 origin-top-right rounded-2xl bg-bg-elevated p-1.5 shadow-float hairline data-[state=open]:animate-in"
        >
          <div className="px-3 pt-2 pb-3">
            <p className="truncate text-sm font-medium text-fg">{name}</p>
            {email ? <p className="truncate text-xs text-fg-subtle">{email}</p> : null}
          </div>
          <DropdownMenu.Separator className="mx-2 my-1 h-px bg-border" />
          <DropdownMenu.Item asChild className={itemClass}>
            <Link href={`/${locale}/settings`}>
              <Settings className="size-4 text-fg-muted" />
              {t("settings")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="mx-2 my-1 h-px bg-border" />
          <DropdownMenu.Label className="px-3 pt-1 pb-1 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{t("theme")}</DropdownMenu.Label>
          <div className="grid grid-cols-3 gap-1 px-1.5 pb-1.5">
            {(
              [
                ["light", Sun, t("themeLight")],
                ["dark", Moon, t("themeDark")],
                ["system", Monitor, t("themeSystem")],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl py-2 text-[11px] transition",
                  theme === value ? "bg-surface-2 text-fg hairline" : "text-fg-muted hover:bg-surface",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
          <DropdownMenu.Separator className="mx-2 my-1 h-px bg-border" />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={itemClass}>
              <Languages className="size-4 text-fg-muted" />
              <span className="flex-1">{t("language")}</span>
              <span className="text-xs text-fg-subtle">{LOCALE_LABELS[locale]}</span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={6} className="z-50 w-44 rounded-2xl bg-bg-elevated p-1.5 shadow-float hairline">
                {LOCALES.map((l) => (
                  <DropdownMenu.Item key={l} disabled={pending} onSelect={() => switchLocale(l)} className={itemClass}>
                    <span className="flex-1">{LOCALE_LABELS[l]}</span>
                    {l === locale ? <Check className="size-4 text-accent" /> : null}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="mx-2 my-1 h-px bg-border" />
          <DropdownMenu.Item className={cn(itemClass, "text-negative")} onSelect={() => startTransition(() => signOut(locale))}>
            <LogOut className="size-4" />
            {t("signOut")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

"use client";

import { Check, Cpu, Database, LoaderCircle, Monitor, Moon, ShieldCheck, Sun, Trash, TriangleAlert } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Switch } from "radix-ui";
import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { DISPLAY_CURRENCIES } from "@/domain/money/currencies";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { deleteAllFinancialData } from "@/server/actions/finance";
import { setAiCloudConsent, setDisplayCurrency, setIncludeBusiness, setLocalePreference, signOut, updateDisplayName } from "@/server/actions/preferences";

export interface SettingsModel {
  displayName: string;
  email: string | null;
  currency: string;
  includeBusiness: boolean;
  aiCloudConsent: boolean;
  appEnv: string;
  ai: { mode: string; model?: string; provider: string; dataDestination: string; healthy: boolean; healthError?: string; disabledReason?: string };
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-[1.75rem] bg-bg-elevated/80 p-5 hairline sm:p-7">
      <h2 className="mb-5 flex items-center gap-2.5 text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">
        {icon}
        {title}
      </h2>
      <div className="flex flex-col divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[14.5px] font-medium text-fg">{label}</p>
        {hint ? <p className="mt-0.5 max-w-md text-[12.5px] leading-relaxed text-fg-subtle">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-7 w-12 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-positive disabled:opacity-50"
    >
      <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-bg-elevated shadow-soft transition-transform data-[state=checked]:translate-x-6" />
    </Switch.Root>
  );
}

export function SettingsView({ model }: { model: SettingsModel }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  // Theme is only known on the client: render the selector after hydration.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(model.displayName);
  const [confirm, setConfirm] = useState("");

  const run = (fn: () => Promise<{ ok: boolean }>, success?: string) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(success ?? t("common.saved"));
      else toast.error(t("common.somethingWrong"));
    });

  const modeLabel =
    model.ai.mode === "mock" ? t("settings.aiModeMock") : model.ai.mode === "omlx" ? t("settings.aiModeOmlx") : model.ai.mode === "cloud" ? t("settings.aiModeCloud") : t("settings.aiModeDisabled");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Section icon={<Check className="size-4" />} title={t("settings.profile")}>
        <Row label={t("settings.displayName")} hint={model.email ?? undefined}>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => updateDisplayName(name));
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-10 w-56" aria-label={t("settings.displayName")} maxLength={80} />
            <Button type="submit" size="md" variant="secondary" disabled={pending || name.trim() === model.displayName}>
              {t("common.save")}
            </Button>
          </form>
        </Row>
      </Section>

      <Section icon={<Monitor className="size-4" />} title={t("settings.preferences")}>
        <Row label={t("settings.language")}>
          <Segmented
            size="sm"
            label={t("settings.language")}
            value={locale}
            onChange={(next: Locale) =>
              startTransition(async () => {
                await setLocalePreference(next);
                router.replace(`/${next}/${pathname.split("/").slice(2).join("/")}`);
              })
            }
            options={LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l] }))}
          />
        </Row>
        <Row label={t("settings.primaryCurrency")} hint={t("settings.primaryCurrencyHint")}>
          <Segmented
            size="sm"
            label={t("settings.primaryCurrency")}
            value={model.currency}
            onChange={(c) => run(() => setDisplayCurrency(c))}
            options={DISPLAY_CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
        </Row>
        <Row label={t("settings.theme")}>
          {mounted ? (
            <Segmented
              size="sm"
              label={t("settings.theme")}
              value={(theme ?? "system") as "light" | "dark" | "system"}
              onChange={setTheme}
              options={[
                { value: "light", label: <Sun className="size-3.5" />, ariaLabel: t("nav.themeLight") },
                { value: "dark", label: <Moon className="size-3.5" />, ariaLabel: t("nav.themeDark") },
                { value: "system", label: <Monitor className="size-3.5" />, ariaLabel: t("nav.themeSystem") },
              ]}
            />
          ) : null}
        </Row>
        <Row label={t("settings.includeBusiness")} hint={t("settings.includeBusinessHint")}>
          <Toggle checked={model.includeBusiness} disabled={pending} label={t("settings.includeBusiness")} onChange={(v) => run(() => setIncludeBusiness(v))} />
        </Row>
      </Section>

      <Section icon={<Cpu className="size-4" />} title={t("settings.ai")}>
        <Row label={t("settings.aiMode")} hint={model.ai.disabledReason}>
          <span className="flex items-center gap-2 text-[14px] text-fg">
            {modeLabel}
            {model.ai.model ? <Badge>{model.ai.model}</Badge> : null}
          </span>
        </Row>
        <Row label={t("settings.aiStatus")}>
          <Badge tone={model.ai.healthy ? "positive" : "warning"}>{model.ai.healthy ? t("settings.aiOk") : t("settings.aiUnavailable")}</Badge>
        </Row>
        <Row label={t("settings.aiCloudConsent")} hint={t("settings.aiCloudConsentHint")}>
          <Toggle
            checked={model.aiCloudConsent}
            disabled={pending || model.ai.mode !== "cloud"}
            label={t("settings.aiCloudConsent")}
            onChange={(v) => run(() => setAiCloudConsent(v))}
          />
        </Row>
        <p className="pt-4 text-[12.5px] text-fg-subtle">{t("settings.aiCalibrationNote")}</p>
      </Section>

      <Section icon={<ShieldCheck className="size-4" />} title={t("settings.security")}>
        <Row label={t("settings.security")} hint={t("settings.securityBody")}>
          <Badge tone="accent">{t("settings.environment")}: {model.appEnv.toUpperCase()}</Badge>
        </Row>
      </Section>

      <Section icon={<Database className="size-4" />} title={t("settings.data")}>
        <div className="flex flex-col gap-4">
          <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-fg-muted">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("settings.dataHint")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t("settings.deleteConfirm")} aria-label={t("settings.deleteConfirm")} className="h-10 sm:w-64" />
            <Button
              variant="danger"
              disabled={pending || confirm !== "DELETE"}
              onClick={() =>
                run(async () => {
                  const r = await deleteAllFinancialData(confirm);
                  if (r.ok) setConfirm("");
                  return r;
                }, t("settings.deleted"))
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Trash />}
              {t("settings.deleteData")}
            </Button>
          </div>
        </div>
      </Section>

      <Button variant="outline" className={cn("self-start")} onClick={() => startTransition(() => signOut(locale))}>
        {t("settings.signOut")}
      </Button>
    </div>
  );
}

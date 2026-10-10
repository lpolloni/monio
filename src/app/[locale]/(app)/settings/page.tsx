import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsView } from "@/components/settings/settings-view";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getT } from "@/i18n/server";
import { getProfile, requireSession } from "@/server/data/session";
import { getServerEnv } from "@/server/env";
import { getAiServiceFor, getAiSummary } from "@/server/runtime";

export const metadata: Metadata = { title: "Settings" };

async function SettingsContent() {
  const [session, profile] = await Promise.all([requireSession(), getProfile()]);
  const summary = getAiSummary();
  const service = getAiServiceFor(profile);
  const health = service ? await service.health() : { ok: false, error: summary.disabledReason };
  return (
    <SettingsView
      model={{
        displayName: profile.displayName ?? "",
        email: session.email,
        currency: profile.primaryCurrency,
        includeBusiness: profile.includeBusiness,
        aiCloudConsent: profile.aiCloudConsent,
        appEnv: getServerEnv().APP_ENV,
        ai: {
          mode: summary.mode,
          model: summary.mode === "mock" || summary.mode === "disabled" ? undefined : summary.model,
          provider: summary.provider,
          dataDestination: summary.dataDestination,
          healthy: health.ok,
          healthError: health.error,
          disabledReason: summary.disabledReason,
        },
      }}
    />
  );
}

export default async function SettingsPage() {
  const t = await getT();
  return (
    <>
      <div className="mx-auto max-w-3xl">
        <PageHeader title={t("settings.title")} />
      </div>
      <Suspense
        fallback={
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-40 !rounded-[1.75rem]" />
            ))}
          </div>
        }
      >
        <SettingsContent />
      </Suspense>
    </>
  );
}

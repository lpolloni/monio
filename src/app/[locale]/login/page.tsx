import type { Metadata } from "next";
import { Suspense } from "react";
import { Logo } from "@/components/shell/logo";
import { getT } from "@/i18n/server";
import { getServerEnv } from "@/server/env";
import { AuthForm } from "./auth-form";
import { OrbitIllustration } from "./orbit-illustration";

export const metadata: Metadata = { title: "Login" };

export default async function LoginPage() {
  const t = await getT();
  const isDev = getServerEnv().APP_ENV === "development";
  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="aurora" aria-hidden />
      <div className="grain" aria-hidden />
      <div className="relative z-10 mx-auto grid min-h-dvh max-w-[1200px] grid-cols-1 items-center gap-10 px-5 py-10 lg:grid-cols-[1.15fr_1fr] lg:px-10">
        <section className="flex flex-col gap-8">
          <Logo />
          <div>
            <h1 className="font-display text-[3.4rem] leading-[0.98] tracking-[-0.015em] text-fg text-balance sm:text-[4.6rem]">
              {t("common.tagline")}
            </h1>
            <p className="mt-5 max-w-md text-[17px] leading-relaxed text-fg-muted">{t("auth.subtitle")}</p>
          </div>
          <OrbitIllustration className="hidden max-w-[520px] lg:block" />
        </section>
        <section className="w-full">
          <div className="mx-auto w-full max-w-md rounded-[2rem] bg-bg-elevated/85 p-7 shadow-float hairline backdrop-blur-xl sm:p-9">
            <Suspense>
              <AuthForm demo={isDev ? { email: "demo@monio.dev", password: "MonioDemo!2026" } : null} />
            </Suspense>
          </div>
          <p className="mx-auto mt-5 max-w-md px-2 text-center text-xs leading-relaxed text-fg-subtle">{t("auth.privacy")}</p>
        </section>
      </div>
    </div>
  );
}

import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AddSheetProvider } from "@/components/shell/add-sheet";
import { HeaderSession, HeaderSessionFallback } from "@/components/shell/header-session";
import { Logo } from "@/components/shell/logo";
import { AddButton, BottomNav, TopNav } from "@/components/shell/nav";
import { getLocale } from "@/i18n/server";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <AddSheetProvider>
      <div className="aurora" aria-hidden />
      <div className="grain" aria-hidden />
      {/* Status-bar veil: blurs content scrolling under the clock, fading out so the page background still reaches the top. */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-30 h-[calc(env(safe-area-inset-top)*1.4)] bg-bg/40 backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
        aria-hidden
      />
      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="px-4 pt-[max(env(safe-area-inset-top),0.75rem)] sm:px-6 lg:px-10">
          <div className="mx-auto flex h-14 max-w-[1280px] items-center justify-between gap-4">
            <Link href={`/${locale}`} className="shrink-0 rounded-full" aria-label="Monio">
              <Logo />
            </Link>
            <TopNav />
            <div className="flex items-center gap-2">
              <AddButton />
              <Suspense fallback={<HeaderSessionFallback />}>
                <HeaderSession />
              </Suspense>
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-6 pb-36 sm:px-6 md:pb-16 lg:px-10 lg:pt-10">
          {children}
        </main>
        <BottomNav />
      </div>
    </AddSheetProvider>
  );
}

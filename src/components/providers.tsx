"use client";

import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { IntlProvider } from "use-intl";
import type { Locale } from "@/i18n/config";
import type { Messages } from "@/i18n/messages/en";
import { ServiceWorkerRegistration } from "./service-worker";

export function Providers({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {/* Statement dates are calendar dates; format them in UTC so they never shift. */}
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <MotionConfig reducedMotion="user">
          {children}
          <ServiceWorkerRegistration />
          <Toaster
            position="top-center"
            toastOptions={{
              classNames: {
                toast: "!rounded-2xl !bg-bg-elevated !text-fg !border-border !shadow-float",
                description: "!text-fg-muted",
              },
            }}
          />
        </MotionConfig>
      </IntlProvider>
    </ThemeProvider>
  );
}

"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Capture the prompt globally, even when Settings has not been opened yet. */
let pendingPrompt: InstallPrompt | null = null;
export function InstallPromptListener() {
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      pendingPrompt = event as InstallPrompt;
      window.dispatchEvent(new Event("monio-install-ready"));
    };
    const installed = () => { pendingPrompt = null; };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  return null;
}

export function InstallApp() {
  const t = useTranslations("pwa");
  const [ready, setReady] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [secure, setSecure] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const sync = () => {
      setReady(!!pendingPrompt);
      setSecure(window.isSecureContext);
      setInstalled(display.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone);
    };
    const onInstalled = () => { setInstalled(true); setReady(false); };
    sync();
    window.addEventListener("monio-install-ready", sync);
    window.addEventListener("appinstalled", onInstalled);
    display.addEventListener("change", sync);
    return () => {
      window.removeEventListener("monio-install-ready", sync);
      window.removeEventListener("appinstalled", onInstalled);
      display.removeEventListener("change", sync);
    };
  }, []);

  async function install() {
    const prompt = pendingPrompt;
    if (!prompt) return;
    pendingPrompt = null;
    setReady(false);
    setBusy(true);
    setError(false);
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[1.75rem] bg-bg-elevated/80 p-5 hairline sm:p-7">
      <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle"><Download className="size-4" />{t("title")}</h2>
      <p className="mb-4 text-sm text-fg-subtle">{t("description")}</p>
      {installed ? <p role="status" className="text-sm text-fg">{t("installed")}</p> : ready ? <Button onClick={install} disabled={busy}><Download />{t("install")}</Button> : <p className="text-sm text-fg-subtle">{t(secure ? "manual" : "insecure")}</p>}
      {error ? <p role="status" className="mt-3 text-sm text-fg-subtle">{t("error")}</p> : null}
    </section>
  );
}

"use client";

import { useEffect } from "react";

/** Registers the static-asset service worker in production builds only. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // PWA install is optional; the app works without it.
    });
  }, []);
  return null;
}

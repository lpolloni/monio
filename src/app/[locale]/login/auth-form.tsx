"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function AuthForm({ demo }: { demo: { email: string; password: string } | null }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  // Inputs are uncontrolled so text typed before hydration is kept; values are read on submit.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Until hydrated, submitting would fall back to a native form submission; keep the button disabled.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const next = (() => {
    const raw = params.get("next");
    // Only allow in-app relative paths to prevent open redirects.
    return raw && raw.startsWith("/") && !raw.startsWith("//") ? `/${locale}${raw}` : `/${locale}`;
  })();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const email = emailRef.current?.value ?? "";
    const password = passwordRef.current?.value ?? "";
    const name = nameRef.current?.value ?? "";
    setPending(true);
    setError(null);
    setNotice(null);
    const supabase = createBrowserSupabase();
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: { data: { display_name: name.trim() || undefined, locale } },
          });
    if (result.error) {
      setPending(false);
      setError(
        result.error.message === "Error sending confirmation email"
          ? t("confirmationEmailError")
          : result.error.code === "invalid_credentials"
            ? t("invalidCredentials")
            : t(mode === "signup" ? "signupError" : "genericError"),
      );
      return;
    }
    if (mode === "signup" && !result.data.session) {
      setPending(false);
      setNotice(t("checkEmail"));
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form method="post" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-[2rem] leading-none text-fg">{mode === "signin" ? t("signIn") : t("signUp")}</h2>
        <Segmented
          size="sm"
          label={t("welcome")}
          value={mode}
          onChange={(v) => {
            setMode(v);
            setError(null);
            setNotice(null);
          }}
          options={[
            { value: "signin", label: t("signIn") },
            { value: "signup", label: t("signUp") },
          ]}
        />
      </div>

      <AnimatePresence initial={false}>
        {mode === "signup" ? (
          <motion.div
            key="name"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-col gap-2 overflow-hidden"
          >
            <Label htmlFor="name">{t("displayName")}</Label>
            <Input ref={nameRef} id="name" name="name" autoComplete="name" />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          ref={emailRef}
          aria-invalid={!!error || undefined}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          required
          minLength={8}
          ref={passwordRef}
          aria-invalid={!!error || undefined}
          aria-describedby={mode === "signup" ? "password-hint" : undefined}
        />
        {mode === "signup" ? (
          <p id="password-hint" className="text-xs text-fg-subtle">
            {t("passwordHint")}
          </p>
        ) : null}
      </div>

      {notice ? <p role="status" className="text-sm text-fg-muted">{notice}</p> : null}

      <AnimatePresence>
        {error ? (
          <motion.p
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl bg-negative-soft px-4 py-3 text-sm text-negative"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <Button type="submit" size="lg" disabled={pending || !hydrated} className="mt-1 w-full">
        {pending ? <LoaderCircle className="animate-spin" /> : null}
        {pending ? (mode === "signin" ? t("signingIn") : t("creating")) : mode === "signin" ? t("signIn") : t("signUp")}
        {!pending ? <ArrowRight /> : null}
      </Button>

      {demo && mode === "signin" ? (
        <button
          type="button"
          onClick={() => {
            if (emailRef.current) emailRef.current.value = demo.email;
            if (passwordRef.current) passwordRef.current.value = demo.password;
          }}
          className="rounded-2xl bg-surface px-4 py-3 text-left text-xs leading-relaxed text-fg-muted hairline transition hover:bg-surface-2"
        >
          {t("demoHint", { email: demo.email, password: demo.password })}
        </button>
      ) : null}
    </form>
  );
}

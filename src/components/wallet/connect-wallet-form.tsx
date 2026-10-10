"use client";

import { Bitcoin, CircleCheck, Hexagon, Info, LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { detectWatchTarget } from "@/domain/crypto/addresses";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { connectWallet } from "@/server/actions/wallets";

export function ConnectWalletForm({ provider }: { provider: string }) {
  const t = useTranslations("wallet");
  const locale = useLocale();
  const router = useRouter();
  const [family, setFamily] = useState<"bitcoin" | "evm">("bitcoin");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [pending, startTransition] = useTransition();

  const check = useMemo(() => (value.trim() ? detectWatchTarget(value) : null), [value]);
  const secret = check && !check.ok && (check.error === "private_key_detected" || check.error === "seed_phrase_detected");
  const familyMismatch = check?.ok && check.target.family !== family;
  const valid = check?.ok && !familyMismatch;

  const typeLabel = (() => {
    if (!check?.ok) return "";
    const tg = check.target;
    if (tg.kind === "address") return tg.family === "evm" ? "EVM address" : `Bitcoin ${tg.addressType ?? ""} address`.replace("  ", " ");
    return tg.kind === "descriptor" ? "descriptor" : (tg.xpubType ?? "xpub");
  })();

  const submit = () => {
    if (!valid) return;
    startTransition(async () => {
      const r = await connectWallet(value, label);
      if (r.ok) {
        toast.success(t("connected"));
        router.push(`/${locale}/explore/${r.accountId}`);
      } else if (r.error === "already_connected") toast.error(t("alreadyConnected"));
      else if (r.error === "private_key_detected") toast.error(t("privateKeyDetected"));
      else if (r.error === "seed_phrase_detected") toast.error(t("seedDetected"));
      else toast.error(t("invalid"));
    });
  };

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.2fr_0.8fr]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-6 rounded-[2rem] bg-bg-elevated/85 p-6 shadow-soft hairline sm:p-8"
      >
        <div className="flex flex-col gap-2">
          <Label>{t("network")}</Label>
          <Segmented
            label={t("network")}
            value={family}
            onChange={setFamily}
            options={[
              { value: "bitcoin", label: <span className="inline-flex items-center gap-1.5"><Bitcoin className="size-3.5" />{t("bitcoin")}</span> },
              { value: "evm", label: <span className="inline-flex items-center gap-1.5"><Hexagon className="size-3.5" />{t("evm")}</span> },
            ]}
          />
          {family === "evm" ? <p className="text-[12.5px] text-fg-subtle">{t("evmNetworks")}</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="wallet-address">{t("addressLabel")}</Label>
          <Input
            id="wallet-address"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={family === "bitcoin" ? t("addressPlaceholderBtc") : t("addressPlaceholderEvm")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono text-[13.5px]"
            aria-invalid={(check && !valid) || undefined}
            aria-describedby="wallet-feedback"
          />
          <div id="wallet-feedback" aria-live="polite" className="min-h-6">
            <AnimatePresence mode="wait">
              {secret ? (
                <motion.p key="secret" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="alert" className="flex items-start gap-2 rounded-2xl bg-negative-soft px-3.5 py-3 text-[13px] leading-relaxed text-negative">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  {check?.ok === false && check.error === "seed_phrase_detected" ? t("seedDetected") : t("privateKeyDetected")}
                </motion.p>
              ) : valid ? (
                <motion.p key="ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5 text-[13px] text-positive">
                  <CircleCheck className="size-4" />
                  {t("valid", { type: typeLabel })}
                </motion.p>
              ) : check && (familyMismatch || !check.ok) ? (
                <motion.p key="bad" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[13px] text-negative">
                  {check.ok === false && check.error === "unsupported" ? t("unsupported") : t("invalid")}
                </motion.p>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="wallet-label">{t("label")}</Label>
          <Input id="wallet-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("labelPlaceholder")} maxLength={80} />
        </div>

        <Button type="submit" size="lg" disabled={!valid || pending} className="self-start">
          {pending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
          {pending ? t("connecting") : t("connect")}
        </Button>
        <p className="text-[12px] text-fg-subtle">{t("providerNote", { provider: provider === "mock" ? t("providerMock") : provider })}</p>
      </form>

      <aside className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-[1.5rem] bg-positive-soft p-5 text-[13.5px] leading-relaxed text-positive">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" />
          {t("readOnly")}
        </div>
        {[t("addressVsXpub"), t("privacyNotice"), t("supportedNetworks")].map((text, i) => (
          <div key={i} className={cn("flex items-start gap-3 rounded-[1.5rem] bg-surface p-5 text-[13.5px] leading-relaxed text-fg-muted hairline")}>
            <Info className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
            {text}
          </div>
        ))}
      </aside>
    </div>
  );
}

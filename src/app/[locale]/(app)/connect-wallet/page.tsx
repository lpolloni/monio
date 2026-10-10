import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectWalletForm } from "@/components/wallet/connect-wallet-form";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getT } from "@/i18n/server";
import { requireSession } from "@/server/data/session";
import { getServerEnv } from "@/server/env";

export const metadata: Metadata = { title: "Connect wallet" };

async function Form() {
  await requireSession();
  return <ConnectWalletForm provider={getServerEnv().BLOCKCHAIN_PROVIDER} />;
}

export default async function ConnectWalletPage() {
  const t = await getT();
  return (
    <>
      <PageHeader title={t("wallet.title")} subtitle={t("wallet.subtitle")} />
      <Suspense fallback={<Skeleton className="h-96 !rounded-[2rem]" />}>
        <Form />
      </Suspense>
    </>
  );
}

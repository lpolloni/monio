import Link from "next/link";
import { getLocale, getT } from "@/i18n/server";

export default async function NotFound() {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-24 text-center">
      <h1 className="font-display text-[2.4rem] leading-tight text-fg">{t("common.notFound")}</h1>
      <Link href={`/${locale}`} className="text-[14px] font-medium text-accent">
        {t("nav.home")}
      </Link>
    </div>
  );
}

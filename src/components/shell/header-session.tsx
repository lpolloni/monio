import { Inbox } from "lucide-react";
import Link from "next/link";
import { getLocale, getT } from "@/i18n/server";
import { getProfile, requireSession } from "@/server/data/session";
import { PrivacyToggle } from "@/components/privacy";
import { UserMenu } from "./user-menu";

/** Session-dependent header controls; rendered inside a Suspense boundary. */
export async function HeaderSession() {
  const [session, profile, locale, t] = await Promise.all([requireSession(), getProfile(), getLocale(), getT()]);
  const { count } = await session.supabase
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  const open = count ?? 0;
  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/${locale}/inbox`}
        className="relative grid size-10 place-items-center rounded-full bg-surface-2 text-fg-muted hairline transition hover:text-fg"
        aria-label={`${t("nav.inbox")}${open ? ` (${open})` : ""}`}
      >
        <Inbox className="size-[18px]" strokeWidth={1.8} />
        {open > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-5 text-accent-fg">
            {open > 99 ? "99+" : open}
          </span>
        ) : null}
      </Link>
      <PrivacyToggle />
      <UserMenu name={profile.displayName ?? session.email ?? "Monio"} email={session.email} />
    </div>
  );
}

export function HeaderSessionFallback() {
  return (
    <div className="flex items-center gap-2" aria-hidden>
      <span className="size-10 rounded-full bg-surface-2" />
      <span className="size-10 rounded-full bg-surface-2" />
      <span className="size-10 rounded-full bg-surface-2" />
    </div>
  );
}

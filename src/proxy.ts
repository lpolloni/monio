import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, negotiateLocale } from "./i18n/config";

const PUBLIC_APP_PATHS = ["/login", "/auth"];

function withCookies(target: NextResponse, source: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  return target;
}

/**
 * Runs before routes render:
 *  1. Refreshes the Supabase session cookie (keeps server rendering authenticated).
 *  2. Ensures every page URL carries a locale prefix (/pt, /en, /it).
 *  3. Sends unauthenticated visitors to the login page. This is a UX guard only;
 *     every data access is re-authorized server-side and by Row Level Security.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  let userId: string | null = null;

  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        },
      },
    });
    const { data } = await supabase.auth.getClaims();
    userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null;
  }

  if (pathname.startsWith("/api/")) return response;

  const segments = pathname.split("/");
  const first = segments[1];
  if (!isLocale(first)) {
    const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
    const locale = isLocale(cookieLocale)
      ? cookieLocale
      : negotiateLocale(request.headers.get("accept-language")) ?? DEFAULT_LOCALE;
    const target = request.nextUrl.clone();
    target.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
    return withCookies(NextResponse.redirect(target), response);
  }

  const rest = `/${segments.slice(2).join("/")}`;
  const isPublic = PUBLIC_APP_PATHS.some((p) => rest === p || rest.startsWith(`${p}/`));

  if (!userId && !isPublic) {
    const target = request.nextUrl.clone();
    target.pathname = `/${first}/login`;
    target.search = rest !== "/" ? `?next=${encodeURIComponent(rest + search)}` : "";
    return withCookies(NextResponse.redirect(target), response);
  }
  if (userId && rest === "/login") {
    const target = request.nextUrl.clone();
    target.pathname = `/${first}`;
    target.search = "";
    return withCookies(NextResponse.redirect(target), response);
  }
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals, metadata files and static assets.
    "/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest|sw.js|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml)$).*)",
  ],
};

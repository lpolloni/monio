/** Session tokens are read only by Monio's server; HTTPS may terminate at the tunnel. */
export function sessionCookieOptions(headers: Pick<Headers, "get">) {
  const secure = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
    || headers.get("origin")?.startsWith("https://") === true;
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure };
}

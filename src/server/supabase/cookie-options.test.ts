import { expect, it } from "vitest";
import { sessionCookieOptions } from "./cookie-options";
it("protects server-managed tokens through TLS termination", () => {
  expect(sessionCookieOptions(new Headers({ "x-forwarded-proto": "https" }))).toEqual({ path: "/", httpOnly: true, sameSite: "lax", secure: true });
  expect(sessionCookieOptions(new Headers({ origin: "https://monio.example.test" })).secure).toBe(true);
  expect(sessionCookieOptions(new Headers()).secure).toBe(false);
});

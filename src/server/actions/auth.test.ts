import { beforeEach, describe, expect, it, vi } from "vitest";
const { signIn, signUp, createClient } = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), createClient: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({ createClient }));
import { authenticate } from "./auth";
const input = { mode: "signin", email: "fictional@example.test", password: "fictional-password", name: "Demo", locale: "pt" };
beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth: { signInWithPassword: signIn, signUp } });
});
describe("server-only authentication", () => {
  it("does not expose sessions or tokens", async () => {
    signIn.mockResolvedValue({ data: { session: { access_token: "secret", refresh_token: "secret" } }, error: null });
    expect(await authenticate(input)).toEqual({ ok: true, confirmationRequired: false });
    expect(signIn).toHaveBeenCalledWith({ email: input.email, password: input.password });
  });
  it("validates untrusted input before contacting Supabase", async () => {
    for (const value of [null, { ...input, locale: "invalid" }, { ...input, mode: "signup", password: "short" }, { ...input, email: "invalid" }]) {
      expect(await authenticate(value)).toEqual({ ok: false, error: "genericError" });
    }
    expect(createClient).not.toHaveBeenCalled();
  });
  it("keeps pending email confirmation separate from a signed-in session", async () => {
    signUp.mockResolvedValue({ data: { session: null }, error: null });
    expect(await authenticate({ ...input, mode: "signup" })).toEqual({ ok: true, confirmationRequired: true });
  });
  it("maps errors without exposing upstream details", async () => {
    signIn.mockResolvedValue({ error: { code: "invalid_credentials", message: "internal details" } });
    expect(await authenticate(input)).toEqual({ ok: false, error: "invalidCredentials" });
    signUp.mockResolvedValue({ error: { message: "Error sending confirmation email" } });
    expect(await authenticate({ ...input, mode: "signup" })).toEqual({ ok: false, error: "confirmationEmailError" });
  });
  it("handles unavailable private backend", async () => {
    createClient.mockRejectedValue(new Error("private endpoint"));
    expect(await authenticate(input)).toEqual({ ok: false, error: "genericError" });
  });
});

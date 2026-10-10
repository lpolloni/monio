import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "./helpers";

describe("Supabase DEV smoke", () => {
  let user: TestUser;
  beforeAll(async () => {
    user = await createTestUser("smoke");
  });
  afterAll(async () => {
    await user?.cleanup();
  });

  it("bootstraps a profile and a personal entity for new users", async () => {
    const { data: profile } = await user.client.from("profiles").select("id, locale, primary_currency").single();
    expect(profile).toMatchObject({ id: user.id, locale: "pt", primary_currency: "EUR" });
    expect(user.personalEntityId).toMatch(/[0-9a-f-]{36}/);
  });
});

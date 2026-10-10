import type { AccountType } from "../import/types";

export type EntityKind = "personal" | "business" | "shared";

/** Asset groups used for wealth distribution views. */
export type AssetGroup = "cash" | "investments" | "crypto" | "liabilities" | "other";

const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set(["credit_card", "loan", "mortgage"]);
const LIQUID_TYPES: ReadonlySet<AccountType> = new Set(["checking", "savings", "cash"]);

export function isLiabilityType(type: AccountType): boolean {
  return LIABILITY_TYPES.has(type);
}

/** Accounts whose positive balance counts as "available balance". */
export function isLiquidType(type: AccountType): boolean {
  return LIQUID_TYPES.has(type);
}

export function assetGroupFor(type: AccountType, signedValueIsNegative: boolean): AssetGroup {
  if (isLiabilityType(type)) return "liabilities";
  if (signedValueIsNegative) return "liabilities"; // e.g. overdrawn checking account
  if (type === "investment") return "investments";
  if (type === "crypto_wallet") return "crypto";
  if (isLiquidType(type)) return "cash";
  return "other";
}

/** Whether an entity's balances belong in the personal net worth by default. */
export function countsAsPersonal(kind: EntityKind, includeBusiness: boolean): boolean {
  if (kind === "business") return includeBusiness;
  return true;
}

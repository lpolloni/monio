/**
 * NUMERIC columns are generated as `number` by `supabase gen types`, but Monio
 * never converts money to JS numbers: decimal strings are sent as-is and
 * PostgREST/Postgres parse them exactly. This helper only adapts the type.
 */
export function dbNumeric(value: string): number;
export function dbNumeric(value: string | null): number | null;
export function dbNumeric(value: string | null): number | null {
  return value as unknown as number | null;
}

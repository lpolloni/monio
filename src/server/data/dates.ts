import "server-only";

/**
 * Current calendar date (UTC). Must only be called after a request-time API
 * (e.g. the session read) so Cache Components treats it as request data.
 */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowDate(): Date {
  return new Date();
}

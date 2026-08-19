/**
 * Turning a caught value into something worth showing a user.
 *
 * `String(e)` on a Supabase/PostgREST error yields "[object Object]" — they are
 * plain objects, not Error instances — which hides the actual failure behind a
 * useless banner. Dig out a real message wherever one exists.
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    // PostgREST: { message, details, hint, code }
    const parts = [o.message, o.details, o.hint].filter(
      (p): p is string => typeof p === 'string' && p.trim() !== '',
    );
    if (parts.length) return parts.join(' — ');
    if (typeof o.error_description === 'string') return o.error_description;
    if (typeof o.error === 'string') return o.error;
    try {
      const json = JSON.stringify(e);
      if (json && json !== '{}') return json;
    } catch { /* circular — fall through */ }
  }
  return 'Something went wrong. Please try again.';
}

// Shared plumbing for the merchant API: authentication, and one shape of reply.
//
// The logic these endpoints expose lives in Postgres functions (0087), which is
// what makes pricing, routing and authorisation testable without deploying
// anything. These wrappers do three things: resolve the key to a restaurant,
// call one function, and turn a database error into an HTTP status.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const merchantCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...merchantCors, 'content-type': 'application/json' },
  });
}

export const preflight = () => new Response('ok', { headers: merchantCors });

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

/**
 * The key may arrive as `X-API-Key: sgo_…` or `Authorization: Bearer sgo_…`.
 *
 * Returns the restaurant's id, or null. Deliberately one answer for unknown,
 * revoked and deactivated: the endpoint is public, and telling a caller *which*
 * of those they hit is telling them a key exists.
 */
export async function authenticate(
  db: SupabaseClient, req: Request,
): Promise<string | null> {
  const header = req.headers.get('x-api-key')
    ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!header) return null;
  const { data, error } = await db.rpc('verify_merchant_key', { p_key: header.trim() });
  if (error) return null;
  return (data as string | null) ?? null;
}

/**
 * Map a Postgres error onto a status a caller can act on.
 *
 * check_violation is the database saying "you asked for something we will not
 * do" — an unserviceable address, a missing field — which is the caller's
 * problem, not ours, so 422 rather than 500.
 */
export function dbError(error: { code?: string; message?: string }): Response {
  const code = error.code ?? '';
  if (code === 'P0002' || code === 'no_data_found') {
    return json({ error: 'not_found', message: error.message ?? 'Not found' }, 404);
  }
  if (code === '23514' || code === 'check_violation') {
    return json({ error: 'unprocessable', message: error.message ?? 'Cannot do that' }, 422);
  }
  if (code === '42501') {
    return json({ error: 'forbidden', message: error.message ?? 'Not allowed' }, 403);
  }
  console.error('merchant api error', error);
  return json({ error: 'server_error', message: 'Something went wrong our end.' }, 500);
}

/** One request, one database function, one reply. */
export async function handle(
  req: Request,
  fn: (db: SupabaseClient, merchantId: string, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();

  const db = serviceClient();
  const merchantId = await authenticate(db, req);
  if (!merchantId) {
    return json({ error: 'unauthorized', message: 'Unknown or revoked API key.' }, 401);
  }

  let body: Record<string, unknown> = {};
  if (req.method !== 'GET') {
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
    }
  } else {
    body = Object.fromEntries(new URL(req.url).searchParams);
  }

  try {
    return await fn(db, merchantId, body);
  } catch (e) {
    return dbError(e as { code?: string; message?: string });
  }
}

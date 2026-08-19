// Shared CORS headers for browser-invoked Edge Functions.
//
// The admin app calls these from https://ebd-admin.vercel.app, so the browser
// sends a preflight OPTIONS request first. Without these headers (and a 2xx
// reply to OPTIONS) the browser blocks the call — surfaced in supabase-js as
// "Failed to send a request to the Edge Function".

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-broadcast-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** JSON/text response with CORS headers merged in. */
export function withCors(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { ...corsHeaders, ...(init.headers ?? {}) },
  });
}

/** Standard 2xx reply to a CORS preflight. */
export const preflight = () => new Response('ok', { headers: corsHeaders });

// Supabase Edge Function: bulk SMS broadcast to an audience.
//
// True bulk send (announcements / promos). Two ways to authorize:
//   1. An authenticated ADMIN calling from the admin app (supabase.functions
//      .invoke sends their JWT) — the function verifies profiles.role = 'admin'.
//   2. Server-to-server with the x-broadcast-secret header.
//
//   supabase secrets set BROADCAST_SECRET=<random>   # optional, for #2
//   supabase secrets set SMS_PROVIDER=bulksms_ph BULKSMS_PH_USERNAME=... BULKSMS_PH_PASSWORD=...
//   supabase functions deploy broadcast-sms
//
// Body: { "message": "...", "audience": "customers"|"riders"|"stores",
//         "numbers": ["09..."] }   // audience OR explicit numbers
//
// Respect consent/opt-out before broadcasting to customers.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendSms } from '../_shared/sms.ts';
import { preflight, withCors } from '../_shared/cors.ts';

const db = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

/** Authorize either an admin JWT or the shared secret. */
async function authorize(req: Request): Promise<boolean> {
  const secret = Deno.env.get('BROADCAST_SECRET');
  if (secret && req.headers.get('x-broadcast-secret') === secret) return true;

  const auth = req.headers.get('Authorization');
  if (!auth) return false;
  const { data } = await createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  ).auth.getUser();
  if (!data.user) return false;
  const { data: profile } = await db()
    .from('profiles').select('role').eq('id', data.user.id).single();
  return profile?.role === 'admin';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return withCors('POST only', { status: 405 });
  if (!(await authorize(req))) return withCors('forbidden', { status: 403 });

  const { message, audience, numbers } = await req.json().catch(() => ({}));
  if (!message || typeof message !== 'string') {
    return withCors('message required', { status: 400 });
  }

  const db2 = db();

  let recipients: string[] = Array.isArray(numbers) ? numbers : [];
  if (audience === 'customers') {
    const { data } = await db2.from('customers').select('mobile_number');
    recipients = (data ?? []).map((r) => r.mobile_number).filter(Boolean);
  } else if (audience === 'riders') {
    const { data } = await db2.from('riders').select('mobile_number').eq('application_status', 'approved');
    recipients = (data ?? []).map((r) => r.mobile_number).filter(Boolean);
  } else if (audience === 'stores') {
    const { data } = await db2.from('stores').select('contact_number').not('contact_number', 'is', null);
    recipients = (data ?? []).map((r) => r.contact_number).filter(Boolean);
  }

  if (recipients.length === 0) return withCors('no recipients', { status: 200 });

  const result = await sendSms(recipients, message);
  return withCors(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
});

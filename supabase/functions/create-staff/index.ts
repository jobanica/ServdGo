// Supabase Edge Function: create a staff account (admin only).
//
// The admin app calls this with the admin's session JWT. It verifies the caller
// is an admin, then uses the service role to create the auth user and set their
// profile role. Deploy:  supabase functions deploy create-staff
//
// (Runs on Supabase's edge runtime — not the local dev stack used for this
// repo's verification.)

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { preflight, withCors } from '../_shared/cors.ts';

const STAFF_ROLES = ['admin', 'manager', 'dispatcher', 'support'];
const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function callerIsAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization');
  if (!auth) return false;
  const { data } = await createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  ).auth.getUser();
  if (!data.user) return false;
  const { data: profile } = await admin().from('profiles').select('role').eq('id', data.user.id).single();
  return profile?.role === 'admin';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return withCors('POST only', { status: 405 });
  if (!(await callerIsAdmin(req))) return withCors('forbidden', { status: 403 });

  const { email, password, role, fullName } = await req.json().catch(() => ({}));
  if (!email || !password || !STAFF_ROLES.includes(role)) {
    return withCors('email, password, and a valid role are required', { status: 400 });
  }

  const db = admin();
  const { data: created, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) return withCors(error.message, { status: 400 });

  // Trigger creates the profile; set the role (and a display name).
  await db.from('profiles')
    .upsert({ id: created.user.id, role, full_name: fullName ?? email }, { onConflict: 'id' });

  return withCors(JSON.stringify({ id: created.user.id }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// Create a console account. There is no sign-up anywhere in ServdGo: every
// account that can open the admin console is made by somebody who already has
// one, and the login details are handed over out of band.
//
// Two callers, two things they are allowed to do:
//
//   franchisor  — creates a city's operator (and any staff role) for a named
//                 city, and can appoint that account as the city's operator.
//   operator    — creates staff for their own city only. The city is taken from
//                 their own profile and never from the request, so an operator
//                 cannot make an account that belongs to another city.
//
// Both checks go through the caller's own token, so `is_franchisor()` answers
// the same way it does for every RLS policy — including answering *false* while
// they are viewing a city as its operator, which is why that case is refused
// explicitly below rather than falling through to the operator branch.
//
// Deploy: supabase functions deploy create-staff

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { preflight, withCors } from '../_shared/cors.ts';

const STAFF_ROLES = ['admin', 'manager', 'dispatcher', 'support'];

const service = () => createClient(
  Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const asCaller = (auth: string) => createClient(
  Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
  { global: { headers: { Authorization: auth } } });

const json = (body: unknown, status = 200) =>
  withCors(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Caller {
  id: string;
  franchisor: boolean;
  territoryId: string | null;
}

async function whoIsAsking(req: Request): Promise<Caller | 'anonymous' | 'viewing' | 'forbidden'> {
  const auth = req.headers.get('Authorization');
  if (!auth) return 'anonymous';

  const db = asCaller(auth);
  const { data: user } = await db.auth.getUser();
  if (!user.user) return 'anonymous';

  // Refused rather than treated as the operator they are impersonating:
  // viewing a city is read-only, and creating an account is not reading.
  const { data: viewing } = await db.rpc('viewing_as_territory');
  if (viewing) return 'viewing';

  const { data: franchisor } = await db.rpc('is_franchisor');

  const { data: profile } = await service()
    .from('profiles').select('role, territory_id').eq('id', user.user.id).single();

  if (!franchisor && profile?.role !== 'admin') return 'forbidden';
  return {
    id: user.user.id,
    franchisor: franchisor === true,
    territoryId: (profile?.territory_id as string | null) ?? null,
  };
}

/** The account this email already belongs to, if any. */
async function findByEmail(db: SupabaseClient, email: string): Promise<string | null> {
  const wanted = email.trim().toLowerCase();
  // listUsers is paged; an installation with more console-eligible users than
  // this has bigger problems than a slow lookup.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data.users.length) return null;
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === wanted);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const caller = await whoIsAsking(req);
  if (caller === 'anonymous') return json({ error: 'Sign in first' }, 401);
  if (caller === 'viewing') {
    return json({
      error: 'You are viewing a city as its operator. Leave the view before creating an account.',
    }, 403);
  }
  if (caller === 'forbidden') return json({ error: 'Not allowed' }, 403);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  const role = String(body.role ?? 'admin');
  const fullName = body.fullName ? String(body.fullName).trim() : '';
  const appoint = body.appointAsOperator === true;
  const attachExisting = body.attachExisting === true;

  if (!email || !password) return json({ error: 'An email and a password are required' }, 400);
  if (password.length < 10) return json({ error: 'Use at least 10 characters' }, 400);
  if (!STAFF_ROLES.includes(role)) return json({ error: `Unknown role ${role}` }, 400);

  // Whose city this account belongs to. An operator does not get to say.
  let territoryId: string | null;
  if (caller.franchisor) {
    territoryId = body.territoryId ? String(body.territoryId) : null;
    if (!territoryId) return json({ error: 'Name the city this account belongs to' }, 400);
  } else {
    territoryId = caller.territoryId;
    if (!territoryId) {
      return json({ error: 'Your own account has no city, so it cannot create one' }, 400);
    }
    if (appoint) return json({ error: 'Only the franchisor appoints an operator' }, 403);
  }

  const db = service();

  const { data: territory } = await db
    .from('territories').select('id, name').eq('id', territoryId).single();
  if (!territory) return json({ error: 'No such city' }, 404);

  // Create the account, or adopt the one that is already there.
  let userId: string;
  let existing = false;
  const { data: created, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
  });

  if (error) {
    const taken = /already|registered|exists/i.test(error.message);
    if (!taken) return json({ error: error.message }, 400);

    const found = await findByEmail(db, email);
    if (!found) return json({ error: error.message }, 400);
    if (!attachExisting) {
      return json({
        error: 'That email already has an account.',
        emailTaken: true,
        message: 'It can be given this role instead — its existing password stays as it is.',
      }, 409);
    }
    userId = found;
    existing = true;
  } else {
    userId = created.user.id;
  }

  const { error: profileError } = await db.from('profiles').upsert({
    id: userId,
    role,
    territory_id: territoryId,
    full_name: fullName || email,
  }, { onConflict: 'id' });
  if (profileError) return json({ error: profileError.message }, 400);

  if (appoint) {
    const { error: appointError } = await db
      .from('territories').update({ operator_profile_id: userId }).eq('id', territoryId);
    if (appointError) return json({ error: appointError.message }, 400);
  }

  // Recorded like every other HQ action. The password is never written down.
  await db.from('audit_log').insert({
    actor_user_id: caller.id,
    actor_role: caller.franchisor ? 'franchisor' : 'admin',
    territory_id: territoryId,
    action: existing ? 'hq.account_attached' : 'hq.account_created',
    entity: 'profile',
    entity_id: userId,
    diff: { email, role, appointed: appoint, territory: territory.name },
  });

  return json({ id: userId, existing, appointed: appoint, territory: territory.name });
});

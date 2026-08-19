/**
 * Every city and who runs it — and the one place to issue a login.
 *
 * This lived only inside a city's Actions tab, three clicks from the menu,
 * which is the wrong place for the thing you do on a franchisee's first day.
 * It is a menu item now. The card inside the city page still works; it is the
 * same component.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listTerritories, listStaff, TERRITORY_STATUS_LABEL,
  type Territory, type StaffMember,
} from '@servdgo/supabase';
import { errMessage, ROLE_LABEL } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote } from '../ui.tsx';
import { OperatorAccount } from './OperatorAccount.tsx';

export function Operators() {
  const navigate = useNavigate();
  const [cities, setCities] = useState<Territory[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [openCity, setOpenCity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [t, s] = await Promise.all([listTerritories(supabase), listStaff(supabase)]);
      setCities(t); setStaff(s);
    } catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!isSupabaseConfigured) {
    return <Muted>Connect Supabase to issue operator accounts.</Muted>;
  }

  const runnerOf = (c: Territory) => staff.find((s) => s.id === c.operator_profile_id);
  const teamOf = (c: Territory) => staff.filter((s) => s.territory_id === c.id);
  const unrun = cities.filter((c) => !runnerOf(c)).length;

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}

      <Card title="How a franchisee gets in">
        <p className="text-sm text-black/60">
          There is no sign-up screen, on purpose — an account that opens a city's console can see
          its customers' addresses and move its money. You create the login here and send them the
          email and temporary password; they change it themselves with "Forgot password?" on the
          sign-in screen. Their own staff are then theirs to add.
        </p>
        {unrun > 0 && (
          <p className="mt-2 text-sm font-semibold text-brand-orange">
            {unrun} {unrun === 1 ? 'city has' : 'cities have'} nobody running {unrun === 1 ? 'it' : 'them'} yet.
          </p>
        )}
      </Card>

      {cities.length === 0 ? (
        <Muted>
          No cities yet. Create one under Territories first — an operator account belongs to a city.
        </Muted>
      ) : cities.map((c) => {
        const runner = runnerOf(c);
        const team = teamOf(c);
        const open = openCity === c.id;
        return (
          <Card key={c.id}
            title={c.name}
            action={
              <button onClick={() => setOpenCity(open ? null : c.id)}
                className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                  runner
                    ? 'ring-1 ring-black/10 hover:bg-black/5'
                    : 'bg-brand-orange text-white hover:opacity-90'
                }`}>
                {open ? 'Close' : runner ? 'Change who runs it' : 'Create the operator account'}
              </button>
            }>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-xs font-medium capitalize text-black/60">
                {TERRITORY_STATUS_LABEL[c.status] ?? c.status}
              </span>
              <span>
                <span className="text-black/40">Operator: </span>
                {runner
                  ? <b>{runner.full_name ?? runner.id.slice(0, 8)}</b>
                  : <span className="font-semibold text-brand-orange">nobody yet</span>}
              </span>
              <span>
                <span className="text-black/40">Their team: </span>
                {team.length === 0 ? 'none' : team.map((m) => ROLE_LABEL[m.role]).join(', ')}
              </span>
              <button onClick={() => navigate(`/hq/tenants/${c.id}`)}
                className="ml-auto text-sm font-semibold text-brand-charcoal hover:underline">
                Open the city →
              </button>
            </div>

            {open && (
              <div className="mt-4 border-t border-black/5 pt-4">
                <OperatorAccount territory={c} staff={staff} onCreated={load} embedded />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

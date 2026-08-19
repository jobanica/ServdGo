/**
 * A build that is too old to run.
 *
 * The only way to retire a version that is already on somebody's phone is for
 * the app to ask, at launch, whether it is still allowed. The answer comes from
 * platform_settings via public_config(), which is reachable without signing in —
 * a rider whose build is broken often cannot sign in, and still has to be told
 * why.
 *
 * Optimistic when it cannot reach the server: a rider mid-shift on a bad
 * connection must not be locked out of a working app by a failed lookup.
 */
import { useEffect, useState } from 'react';
import { publicConfig, versionAtLeast } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';
import { APP_VERSION } from './config.ts';

type State = { ok: true } | { ok: false; required: string; message: string | null };

export function VersionGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ ok: true });

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void publicConfig(supabase)
      .then((c) => {
        if (!alive) return;
        if (!versionAtLeast(APP_VERSION, c.min_rider_app_version)) {
          setState({ ok: false, required: c.min_rider_app_version, message: c.maintenance_message });
        }
      })
      .catch(() => { /* unreachable — let them work */ });
    return () => { alive = false; };
  }, []);

  if (state.ok) return <>{children}</>;

  return (
    <div className="grid min-h-screen place-items-center bg-[#f7f5f3] p-6 text-center text-brand-ink">
      <div className="max-w-sm">
        <p className="text-4xl">🛵</p>
        <h1 className="mt-3 text-xl font-extrabold">Update ServdGo to keep riding</h1>
        <p className="mt-2 text-sm text-black/60">
          This phone is running {APP_VERSION}. Version {state.required} or newer is required.
        </p>
        {state.message && (
          <p className="mt-3 rounded-xl bg-brand-yellow/20 px-3 py-2 text-sm">{state.message}</p>
        )}
        <p className="mt-4 text-xs text-black/45">
          Install the latest build, then reopen the app.
        </p>
      </div>
    </div>
  );
}

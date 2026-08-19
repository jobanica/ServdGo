/**
 * Sound the alert when a request lands in the pool, and keep nagging while it
 * waits.
 */

import { useEffect, useRef } from 'react';
import { armAlertSound, playNewOrderAlert } from './alert.ts';

/** How often to re-announce a request nobody has taken. */
const NAG_MS = 25_000;

export function useNewOrderAlert(orderIds: readonly string[], active: boolean): void {
  useEffect(() => armAlertSound(), []);

  const seen = useRef<Set<string> | null>(null);
  const key = orderIds.join(',');

  useEffect(() => {
    const ids = key ? key.split(',') : [];

    // The first pool we ever see is not news — it is whatever was already
    // waiting when the app opened. Chiming for it would greet every cold start
    // with an alarm.
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }

    if (!active) {
      // Offline or locked: nothing here is acceptable, so nothing is announced.
      // Still record what is out there, or going back online would replay the
      // whole pool as if it had just arrived.
      seen.current = new Set(ids);
      return;
    }

    const fresh = ids.filter((id) => !seen.current!.has(id));
    seen.current = new Set(ids);
    if (fresh.length > 0) playNewOrderAlert();
  }, [key, active]);

  // A rider with the phone in a pocket misses one chime. Repeat while the pool
  // is not empty — the sound stops the moment somebody takes the request.
  useEffect(() => {
    if (!active || !key) return;
    const t = setInterval(playNewOrderAlert, NAG_MS);
    return () => clearInterval(t);
  }, [key, active]);
}

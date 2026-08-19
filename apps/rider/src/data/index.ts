import { supabase } from '../lib/supabase.ts';
import { createPreviewData } from './preview.ts';
import { createLiveData } from './live.ts';
import type { RiderData } from './types.ts';

// The rider id comes from the authenticated, approved rider (or VITE_RIDER_ID
// as a dev override). Preview mode when neither a client nor an id is present.
const ENV_RIDER_ID = import.meta.env.VITE_RIDER_ID as string | undefined;

export function makeRiderData(riderId?: string): RiderData {
  const id = riderId ?? ENV_RIDER_ID;
  if (supabase && id) return createLiveData(supabase, id);
  return createPreviewData();
}

export type { RiderData, RiderOrder } from './types.ts';

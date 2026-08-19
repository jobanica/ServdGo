import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ensureCustomer, getMyCustomer, listAddresses, onAuthChange, signOut as sbSignOut } from '@ebd/supabase';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { REQUIRE_ACCOUNT } from '../config.ts';

interface AuthValue {
  /** Whether the app is wired to a real backend (vs preview sample mode). */
  live: boolean;
  /** Still resolving the current session (avoid flashing the sign-in screen). */
  loading: boolean;
  /** Signed in with a verified email. */
  authed: boolean;
  /** Signed in but hasn't added a phone number yet (required before ordering). */
  needsPhone: boolean;
  /** Has a phone but no saved address yet — the last step before ordering. */
  needsAddress: boolean;
  /** Re-check the profile after saving an address. */
  refresh: () => Promise<void>;
  /** The signed-in user's email. */
  email: string;
  /** The customer's id (used on orders). */
  customerId: string | null;
  /** The customer's saved mobile number. */
  mobile: string;
  /** The customer's saved name. Required before an order can be placed. */
  name: string;
  /** Save the customer's phone and name; returns the customer id. */
  ensureContact: (mobile: string, name?: string) => Promise<string>;
  signOut: () => Promise<void>;
}

const PREVIEW: AuthValue = {
  live: false, loading: false, authed: true, needsPhone: false, needsAddress: false, email: '',
  customerId: 'preview-customer', mobile: '', name: '',
  ensureContact: async () => 'preview-customer', refresh: async () => {}, signOut: async () => {},
};

const Ctx = createContext<AuthValue>(PREVIEW);
export const useAuth = () => useContext(Ctx);

const hasRealPhone = (m: string | null | undefined) => !!m && m.trim() !== '' && m !== 'unknown';

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!isSupabaseConfigured || !supabase) {
    return <Ctx.Provider value={PREVIEW}>{children}</Ctx.Provider>;
  }
  return <LiveAuthProvider>{children}</LiveAuthProvider>;
}

function LiveAuthProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const [addressCount, setAddressCount] = useState<number | null>(null);
  const inflight = useRef<Promise<string> | null>(null);

  useEffect(() => onAuthChange(supabase!, (u) => {
    setUserId(u?.id ?? null);
    setEmail(u?.email ?? '');
    if (!u) { setCustomerId(null); setMobile(''); setName(''); setAddressCount(null); setLoading(false); }
  }), []);

  // Load the customer row (to know if a phone number is on file).
  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    getMyCustomer(supabase!)
      .then(async (c) => {
        setCustomerId(c?.id ?? null);
        setMobile(c?.mobile_number && c.mobile_number !== 'unknown' ? c.mobile_number : '');
        setName(c?.name?.trim() ?? '');
        if (!c) { setAddressCount(null); return; }
        try { setAddressCount((await listAddresses(supabase!, c.id)).length); }
        catch { setAddressCount(null); }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  async function ensureContact(m: string, n?: string): Promise<string> {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      const id = await ensureCustomer(supabase!, { mobile: m || mobile || 'unknown', name: n });
      setCustomerId(id);
      if (hasRealPhone(m)) setMobile(m);
      if (n?.trim()) setName(n.trim());
      try { setAddressCount((await listAddresses(supabase!, id)).length); } catch { /* checked again on refresh */ }
      return id;
    })();
    inflight.current = run;
    try { return await run; } finally { inflight.current = null; }
  }

  async function refresh(): Promise<void> {
    if (!customerId) return;
    try { setAddressCount((await listAddresses(supabase!, customerId)).length); } catch { /* keep what we had */ }
  }

  const authed = REQUIRE_ACCOUNT ? Boolean(userId) : true;
  const needsPhone = REQUIRE_ACCOUNT ? Boolean(userId) && !hasRealPhone(mobile) : false;
  // Only once we actually know the count: a slow lookup shouldn't throw a
  // returning customer back into onboarding.
  const needsAddress = REQUIRE_ACCOUNT && !needsPhone && Boolean(customerId) && addressCount === 0;

  const value: AuthValue = {
    live: true, loading: REQUIRE_ACCOUNT ? loading : false,
    authed, needsPhone, needsAddress, email, customerId, mobile, name,
    ensureContact, refresh,
    signOut: async () => { await sbSignOut(supabase!); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

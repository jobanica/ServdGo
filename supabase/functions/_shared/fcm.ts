// Firebase Cloud Messaging, the version that still exists.
//
// The old sender in this repo posted to fcm.googleapis.com/fcm/send with an
// `Authorization: key=…` server key. Google turned that API off in June 2024,
// so every push it ever sent since has been a 404 nobody was watching. This is
// the HTTP v1 API: one message per device, addressed per project, authorised
// with an OAuth token minted from a service account.
//
// Set one secret, the whole service-account JSON as a single line:
//
//   supabase secrets set FCM_SERVICE_ACCOUNT="$(cat service-account.json)"
//
// Firebase console → Project settings → Service accounts → Generate new private
// key. Without it every function here returns { sent: 0, reason: 'not_configured' }
// rather than throwing: a rider missing a chime must never fail the thing that
// was trying to tell them.

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface PushTarget { token: string; platform?: string | null }

let cached: { token: string; expires: number } | null = null;

function account(): ServiceAccount | null {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as ServiceAccount;
    return a.project_id && a.client_email && a.private_key ? a : null;
  } catch {
    console.error('FCM_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
}

const b64url = (bytes: Uint8Array | string): string => {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** PEM → CryptoKey. The header, the newlines and the base64 all have to go. */
async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
}

/**
 * An access token, minted from the service account and kept until it is nearly
 * stale. One edge-function instance serves many messages; asking Google for a
 * fresh token on each of them is a round trip nobody needs.
 */
async function accessToken(a: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expires > now + 60) return cached.token;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: a.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signed = `${header}.${claims}`;
  const key = await importKey(a.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signed)));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signed}.${b64url(sig)}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error('FCM token exchange failed', res.status, body?.error_description ?? body?.error);
    return null;
  }
  cached = { token: body.access_token, expires: now + Number(body.expires_in ?? 3600) };
  return cached.token;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Travels to the app as data, so a tap can open the right screen. */
  data?: Record<string, string>;
  /** Android collapses notifications sharing a tag; a second message replaces the first. */
  tag?: string;
  channelId?: string;
}

export interface PushResult { sent: number; failed: number; dead: string[]; reason?: string }

/**
 * Send to every device, and report which tokens the server says are gone.
 *
 * FCM v1 is one HTTP call per token — there is no multicast in this API — so
 * they go out together and the failures come back as a list rather than an
 * exception. UNREGISTERED and INVALID_ARGUMENT mean the token is dead and the
 * caller should stop keeping it.
 */
export async function sendPush(targets: PushTarget[], msg: PushMessage): Promise<PushResult> {
  const a = account();
  if (!a) return { sent: 0, failed: 0, dead: [], reason: 'not_configured' };
  if (targets.length === 0) return { sent: 0, failed: 0, dead: [] };

  const token = await accessToken(a);
  if (!token) return { sent: 0, failed: 0, dead: [], reason: 'auth_failed' };

  const url = `https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`;
  let sent = 0, failed = 0;
  const dead: string[] = [];

  await Promise.all(targets.map(async (t) => {
    const payload = {
      message: {
        token: t.token,
        notification: { title: msg.title, body: msg.body },
        data: msg.data ?? {},
        android: {
          priority: 'HIGH',
          notification: {
            channel_id: msg.channelId ?? 'servdgo',
            tag: msg.tag,
            sound: 'default',
            default_vibrate_timings: true,
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', 'thread-id': msg.tag } },
        },
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) { sent++; return; }
    failed++;
    const err = await res.json().catch(() => ({}));
    const status = err?.error?.details?.[0]?.errorCode ?? err?.error?.status;
    if (status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT' || res.status === 404) {
      dead.push(t.token);
    } else {
      console.error('FCM send failed', res.status, status);
    }
  }));

  return { sent, failed, dead };
}

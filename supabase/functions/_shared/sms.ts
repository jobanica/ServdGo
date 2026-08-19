// Provider-agnostic SMS sender for Supabase Edge Functions (Deno).
//
// Choose the provider with the SMS_PROVIDER env var:
//   bulksms_ph  → iSMS gateway (bulksms.com.ph). Bulk: up to 300 numbers/request.
//   semaphore   → Semaphore (semaphore.co). Bulk: comma-separated numbers.
//
// Env by provider:
//   bulksms_ph: BULKSMS_PH_USERNAME, BULKSMS_PH_PASSWORD, BULKSMS_PH_SENDER (opt)
//   semaphore : SEMAPHORE_API_KEY, SEMAPHORE_SENDER_NAME (opt)

/** Normalize a PH mobile to 639XXXXXXXXX (mirror of @servdgo/shared normalizePhMobile). */
export function normalizePhMobile(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.startsWith('63')) return d;
  if (d.startsWith('0')) return '63' + d.slice(1);
  if (d.startsWith('9') && d.length === 10) return '63' + d;
  return d;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface SmsResult {
  provider: string;
  recipients: number;
  batches: number;
  ok: boolean;
}

/** Send one body to many recipients, batching per the provider's bulk limit. */
export async function sendSms(recipientsRaw: string[], body: string): Promise<SmsResult> {
  const provider = Deno.env.get('SMS_PROVIDER') ?? 'semaphore';
  const recipients = [...new Set(recipientsRaw.map(normalizePhMobile))].filter((n) => n.length >= 11);
  if (recipients.length === 0) return { provider, recipients: 0, batches: 0, ok: true };

  if (provider === 'bulksms_ph') return sendViaISms(recipients, body);
  return sendViaSemaphore(recipients, body);
}

// --- BulkSMS Philippines / iSMS -------------------------------------------
async function sendViaISms(recipients: string[], body: string): Promise<SmsResult> {
  const un = Deno.env.get('BULKSMS_PH_USERNAME');
  const pwd = Deno.env.get('BULKSMS_PH_PASSWORD');
  if (!un || !pwd) throw new Error('BULKSMS_PH_USERNAME/PASSWORD not set');
  const sender = Deno.env.get('BULKSMS_PH_SENDER');

  const batches = chunk(recipients, 300); // iSMS allows up to 300 numbers/request
  let ok = true;
  for (const batch of batches) {
    const params = new URLSearchParams({
      un, pwd,
      dstno: batch.join(';'),
      msg: body,
      type: '1',           // 1 = ASCII/English
      agreedterm: 'YES',
    });
    if (sender) params.set('sendid', sender);
    const res = await fetch('https://www.isms.com.my/isms_send.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = (await res.text()).trim();
    // Success = "2000" or empty; anything else is an error code.
    if (!res.ok || (text !== '' && !text.startsWith('2000'))) ok = false;
  }
  return { provider: 'bulksms_ph', recipients: recipients.length, batches: batches.length, ok };
}

// --- Semaphore -------------------------------------------------------------
async function sendViaSemaphore(recipients: string[], body: string): Promise<SmsResult> {
  const apikey = Deno.env.get('SEMAPHORE_API_KEY');
  if (!apikey) throw new Error('SEMAPHORE_API_KEY not set');
  const sendername = Deno.env.get('SEMAPHORE_SENDER_NAME') ?? undefined;

  const batches = chunk(recipients, 1000); // Semaphore accepts comma-separated bulk
  let ok = true;
  for (const batch of batches) {
    const res = await fetch('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey, number: batch.join(','), message: body, sendername }),
    });
    if (!res.ok) ok = false;
  }
  return { provider: 'semaphore', recipients: recipients.length, batches: batches.length, ok };
}

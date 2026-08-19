/**
 * Rider application + approval data access (admin side).
 */

import type { RiderApplicationStatus } from '@servdgo/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RiderApplicationInput {
  profileId: string;
  name: string;
  mobileNumber: string;
  idDocument?: string;
  vehicle?: string;
}

/** A rider applies through the app; starts in `pending`. */
export async function applyAsRider(db: SupabaseClient, input: RiderApplicationInput) {
  const { data, error } = await db
    .from('riders')
    .insert({
      profile_id: input.profileId,
      name: input.name,
      mobile_number: input.mobileNumber,
      id_document: input.idDocument ?? null,
      vehicle: input.vehicle ?? null,
      application_status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** List rider applications, optionally filtered by status (admin). */
export async function listRiders(db: SupabaseClient, status?: RiderApplicationStatus) {
  let q = db.from('riders').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('application_status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Read a rider's current online/offline availability. */
export async function getRiderOnline(db: SupabaseClient, riderId: string): Promise<boolean> {
  const { data, error } = await db
    .from('riders')
    .select('is_online')
    .eq('id', riderId)
    .maybeSingle();
  if (error) throw error;
  return Boolean((data as { is_online?: boolean } | null)?.is_online);
}

/**
 * A rider marks themselves online/offline. Goes through the set_rider_online
 * RPC (SECURITY DEFINER) so only the is_online flag on the caller's own row is
 * touched — riders can't update their row directly. Returns the new state.
 */
export async function setRiderOnline(db: SupabaseClient, online: boolean): Promise<boolean> {
  const { data, error } = await db.rpc('set_rider_online', { p_online: online });
  if (error) throw error;
  return Boolean(data);
}

/**
 * How many riders could take an order for this service right now — on duty,
 * approved, not suspended, and not held by the settlement gate.
 *
 * Zero means nobody would see the request: the customer should be told before
 * they place it, not left waiting on a pool nobody is watching. Callable by
 * customers (they can't read the riders table itself).
 */
export async function countAvailableRiders(
  db: SupabaseClient,
  service?: 'food' | 'pabili' | 'padala',
): Promise<number> {
  const { data, error } = await db.rpc('riders_available', { p_service: service ?? null });
  if (error) throw error;
  return Number(data ?? 0);
}

export interface DeleteAccountResult {
  deleted: boolean;
  reason?: 'active_orders' | 'unsettled_balance';
  message?: string;
}

/**
 * Delete the signed-in user's own account.
 *
 * Personal details and the login go; the orders themselves stay, stripped of
 * everything identifying — the operator needs them for tax and settlement, and
 * the other side of a delivery isn't one party's to erase. Refuses while a
 * delivery is in flight or a rider still owes commission, with a message to
 * show the user.
 */
export async function deleteMyAccount(db: SupabaseClient): Promise<DeleteAccountResult> {
  const { data, error } = await db.rpc('delete_my_account');
  if (error) throw error;
  return (data ?? { deleted: false }) as DeleteAccountResult;
}

export interface RiderProfile {
  id: string;
  name: string;
  mobile_number: string;
  vehicle: string | null;
  photo_url: string | null;
  payout_number: string | null;
  services_accepted: string[] | null;
  push_enabled: boolean;
  application_status: string;
  orcr_doc: string | null;
  license_doc: string | null;
  proof_address_doc: string | null;
  documents_verified: boolean;
}

/** Read the signed-in rider's full profile (own row, via riders_self_read). */
export async function getRiderProfile(db: SupabaseClient, riderId: string): Promise<RiderProfile | null> {
  const { data, error } = await db
    .from('riders')
    .select('id, name, mobile_number, vehicle, photo_url, payout_number, services_accepted, push_enabled, application_status, orcr_doc, license_doc, proof_address_doc, documents_verified')
    .eq('id', riderId)
    .maybeSingle();
  if (error) throw error;
  return (data as RiderProfile | null) ?? null;
}

/** The three verification documents a rider must file before going online. */
export type RiderDocumentKind = 'orcr' | 'license' | 'proof_address';

export const RIDER_DOCUMENT_LABELS: Record<RiderDocumentKind, string> = {
  orcr: 'OR/CR',
  license: "Driver's license",
  proof_address: 'Proof of address',
};

/**
 * Upload a rider verification document to the private `rider-docs` bucket and
 * record its path on the caller's own rider row. Returns the storage path.
 * Files live under `{uid}/{kind}.{ext}` and overwrite any previous upload.
 */
export async function uploadRiderDocument(
  db: SupabaseClient,
  kind: RiderDocumentKind,
  file: File,
): Promise<string> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${user.id}/${kind}.${ext}`;
  const { error: upErr } = await db.storage.from('rider-docs')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (upErr) throw upErr;
  const { error } = await db.rpc('set_rider_documents', {
    p_orcr: kind === 'orcr' ? path : null,
    p_license: kind === 'license' ? path : null,
    p_proof_address: kind === 'proof_address' ? path : null,
  });
  if (error) throw error;
  return path;
}

/** A short-lived signed URL to view a rider document (own docs or, for staff, any). */
export async function getRiderDocumentUrl(db: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await db.storage.from('rider-docs').createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

/** True when all three verification documents are on file. */
export const riderDocumentsComplete = (r: {
  orcr_doc: string | null; license_doc: string | null; proof_address_doc: string | null;
}): boolean => Boolean(r.orcr_doc && r.license_doc && r.proof_address_doc);

export interface RiderProfilePatch {
  name: string;
  mobile: string;
  vehicle?: string | null;
  photoUrl?: string | null;
  payoutNumber?: string | null;
  services?: string[] | null; // null = accept all services
  pushEnabled?: boolean;
}

/** Update the caller's own rider profile via the update_rider_profile RPC. */
export async function updateRiderProfile(db: SupabaseClient, patch: RiderProfilePatch): Promise<void> {
  const { error } = await db.rpc('update_rider_profile', {
    p_name: patch.name,
    p_mobile: patch.mobile,
    p_vehicle: patch.vehicle ?? null,
    p_photo_url: patch.photoUrl ?? null,
    p_payout_number: patch.payoutNumber ?? null,
    p_services: patch.services ?? null,
    p_push_enabled: patch.pushEnabled ?? null,
  });
  if (error) throw error;
}

/** Upload a rider's avatar to the public store-assets bucket; returns its URL. */
export async function uploadRiderPhoto(db: SupabaseClient, file: File): Promise<string> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `rider-avatars/${user.id}/${Date.now()}.${ext}`;
  const { error: upErr } = await db.storage.from('store-assets')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (upErr) throw upErr;
  return db.storage.from('store-assets').getPublicUrl(path).data.publicUrl;
}

/** Admin approves or rejects an application. */
export async function setRiderApplicationStatus(
  db: SupabaseClient,
  riderId: string,
  status: RiderApplicationStatus,
) {
  const { error } = await db
    .from('riders')
    .update({ application_status: status })
    .eq('id', riderId);
  if (error) throw error;
}

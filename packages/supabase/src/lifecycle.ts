/**
 * Franchisee lifecycle — the pipeline a city moves through, and the paperwork
 * and checks that gate it.
 *
 * lead → applied → approved → onboarding → live, plus suspended and terminated.
 * The gate on `live` is enforced in Postgres, not here: `goLive` will throw with
 * the outstanding items named if the checklist is not clear, whatever the UI
 * believes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type TerritoryStatus =
  | 'lead' | 'applied' | 'approved' | 'onboarding' | 'live' | 'suspended' | 'terminated';

/** In pipeline order, which is also the enum's sort order. */
export const TERRITORY_PIPELINE: TerritoryStatus[] =
  ['lead', 'applied', 'approved', 'onboarding', 'live', 'suspended', 'terminated'];

export const TERRITORY_STATUS_LABEL: Record<TerritoryStatus, string> = {
  lead: 'Lead', applied: 'Applied', approved: 'Approved', onboarding: 'Onboarding',
  live: 'Live', suspended: 'Suspended', terminated: 'Terminated',
};

export interface ChecklistItem {
  id: string;
  territory_id: string;
  item_key: string;
  label: string;
  sort_order: number;
  /** True when the database answers this item itself; it cannot be hand-ticked. */
  auto: boolean;
  done: boolean;
  done_by: string | null;
  done_at: string | null;
}

export interface TerritoryDocument {
  id: string;
  territory_id: string;
  kind: string;
  label: string | null;
  file_url: string;
  expires_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface DocumentExpiry {
  id: string;
  territory_id: string;
  territory_name: string;
  kind: string;
  label: string | null;
  expires_at: string;
  days_left: number;
  state: 'ok' | 'expiring' | 'expired';
}

export interface ConfigChange {
  id: string;
  territory_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: string;
}

export interface AuditEntry {
  id: number;
  actor_user_id: string | null;
  actor_role: string | null;
  territory_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  diff: Record<string, unknown> | null;
  created_at: string;
}

const DOCUMENTS_BUCKET = 'territory-documents';

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export async function listChecklist(
  db: SupabaseClient, territoryId: string,
): Promise<ChecklistItem[]> {
  // Ask the database to answer its own items before reading them back, so the
  // screen never shows a boundary as missing when one has just been drawn.
  await db.rpc('refresh_territory_checklist', { p_territory: territoryId });
  const { data, error } = await db
    .from('territory_onboarding_checklist')
    .select('id, territory_id, item_key, label, sort_order, auto, done, done_by, done_at')
    .eq('territory_id', territoryId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []) as ChecklistItem[];
}

/** Tick or untick a human item. Automatic items are refused by the database. */
export async function setChecklistItem(
  db: SupabaseClient, territoryId: string, itemKey: string, done: boolean,
): Promise<void> {
  const { error } = await db.rpc('set_checklist_item', {
    p_territory: territoryId, p_item: itemKey, p_done: done,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Status transitions. Each is franchisor-only and audit-logged in the database.
// ---------------------------------------------------------------------------

export async function setTerritoryStatus(
  db: SupabaseClient, territoryId: string, status: TerritoryStatus,
): Promise<void> {
  const { error } = await db.from('territories').update({ status }).eq('id', territoryId);
  if (error) throw error;
}

/** Appoint and approve. Does not open the city — that is `goLive`. */
export async function approveTerritory(db: SupabaseClient, territoryId: string): Promise<void> {
  const { error } = await db.rpc('approve_territory', { p_territory: territoryId });
  if (error) throw error;
}

/** Open for business. Throws, naming what is outstanding, if the checklist is not clear. */
export async function goLive(db: SupabaseClient, territoryId: string): Promise<void> {
  const { error } = await db.rpc('go_live', { p_territory: territoryId });
  if (error) throw error;
}

export async function suspendTerritory(
  db: SupabaseClient, territoryId: string, reason?: string,
): Promise<void> {
  const { error } = await db.rpc('suspend_territory', {
    p_territory: territoryId, p_reason: reason ?? null,
  });
  if (error) throw error;
}

/**
 * End a franchise. Irreversible in practice — the city's history stays, but its
 * ground is released for another operator, so the UI should make the caller
 * type the name first.
 */
export async function terminateTerritory(
  db: SupabaseClient, territoryId: string,
): Promise<void> {
  const { error } = await db.from('territories').update({ status: 'terminated' }).eq('id', territoryId);
  if (error) throw error;
}

/** Which live cities a proposed boundary would collide with, before saving it. */
export async function checkOverlap(
  db: SupabaseClient,
  boundary: { lat: number; lng: number; radiusKm: number; excludeTerritoryId?: string },
): Promise<{ id: string; name: string; overlap_km: number }[]> {
  const { data, error } = await db.rpc('territories_overlap', {
    p_lat: boundary.lat, p_lng: boundary.lng, p_radius_km: boundary.radiusKm,
    p_exclude: boundary.excludeTerritoryId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as { id: string; name: string; overlap_km: number }[];
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function listDocuments(
  db: SupabaseClient, territoryId: string,
): Promise<TerritoryDocument[]> {
  const { data, error } = await db
    .from('territory_documents')
    .select('id, territory_id, kind, label, file_url, expires_at, verified_by, verified_at, created_at')
    .eq('territory_id', territoryId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as TerritoryDocument[];
}

/** Everything expiring or expired, across every city. */
export async function listExpiringDocuments(db: SupabaseClient): Promise<DocumentExpiry[]> {
  const { data, error } = await db
    .from('territory_document_expiry')
    .select('id, territory_id, territory_name, kind, label, expires_at, days_left, state')
    .neq('state', 'ok')
    .order('days_left');
  if (error) throw error;
  return (data ?? []) as DocumentExpiry[];
}

export async function uploadDocument(
  db: SupabaseClient,
  params: { territoryId: string; kind: string; label?: string; file: File; expiresAt?: string },
): Promise<string> {
  // Foldered by territory so the storage policy can scope by path alone.
  const ext = params.file.name.split('.').pop() ?? 'bin';
  const path = `${params.territoryId}/${params.kind}-${Date.now()}.${ext}`;
  const up = await db.storage.from(DOCUMENTS_BUCKET).upload(path, params.file, { upsert: false });
  if (up.error) throw up.error;

  const { error } = await db.from('territory_documents').insert({
    territory_id: params.territoryId,
    kind: params.kind,
    label: params.label ?? null,
    file_url: path,
    expires_at: params.expiresAt ?? null,
  });
  if (error) throw error;
  return path;
}

/** The bucket is private, so viewing means a short-lived signed URL. */
export async function signedDocumentUrl(
  db: SupabaseClient, path: string, seconds = 120,
): Promise<string> {
  const { data, error } = await db.storage.from(DOCUMENTS_BUCKET).createSignedUrl(path, seconds);
  if (error) throw error;
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// History and audit
// ---------------------------------------------------------------------------

export async function listConfigHistory(
  db: SupabaseClient, territoryId: string, limit = 50,
): Promise<ConfigChange[]> {
  const { data, error } = await db
    .from('territory_config_history')
    .select('id, territory_id, field, old_value, new_value, changed_by, changed_at')
    .eq('territory_id', territoryId)
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ConfigChange[];
}

export async function listAudit(
  db: SupabaseClient,
  filter: { territoryId?: string; action?: string; actorId?: string; since?: string } = {},
  limit = 200,
): Promise<AuditEntry[]> {
  let q = db
    .from('audit_log')
    .select('id, actor_user_id, actor_role, territory_id, action, entity, entity_id, diff, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter.territoryId) q = q.eq('territory_id', filter.territoryId);
  if (filter.action) q = q.ilike('action', `%${filter.action}%`);
  if (filter.actorId) q = q.eq('actor_user_id', filter.actorId);
  if (filter.since) q = q.gte('created_at', filter.since);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AuditEntry[];
}

/** Record an HQ action that has no trigger behind it. */
export async function logAction(
  db: SupabaseClient,
  entry: { action: string; entity?: string; entityId?: string; territoryId?: string; diff?: unknown },
): Promise<void> {
  const { error } = await db.rpc('log_action', {
    p_action: entry.action,
    p_entity: entry.entity ?? null,
    p_entity_id: entry.entityId ?? null,
    p_territory: entry.territoryId ?? null,
    p_diff: entry.diff ?? null,
  });
  if (error) throw error;
}

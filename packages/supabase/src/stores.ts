/**
 * Stores & menus data access.
 *
 * Admin owns all store/menu data (no merchant login). Customers read only
 * available stores; the per-store `is_available` flag is the merchant on/off
 * toggle, independent of the system-wide operating-hours switch.
 */

import { roundPeso } from '@ebd/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface StoreInput {
  name: string;
  category?: string;
  address?: string;
  lat?: number;
  lng?: number;
  contactNumber?: string;
  /** Daily opening hours as "HH:MM" (Philippine time). Omit for no schedule. */
  opensAt?: string | null;
  closesAt?: string | null;
  /** Weekdays the store is open (0=Sun…6=Sat). Omit/null = every day. */
  openDays?: number[] | null;
}

export interface MenuItemInput {
  storeId: string;
  categoryId?: string;
  name: string;
  description?: string;
  price: number;
}

/** Customer-facing: only stores currently available. */
export async function listAvailableStores(db: SupabaseClient) {
  const { data, error } = await db
    .from('stores')
    .select('*')
    .eq('is_available', true)
    .order('name');
  if (error) throw error;
  return data ?? [];
}

/** Admin-facing: all stores including unavailable ones. */
export async function listAllStores(db: SupabaseClient) {
  const { data, error } = await db.from('stores').select('*').order('name');
  if (error) throw error;
  return data ?? [];
}

export async function createStore(db: SupabaseClient, input: StoreInput) {
  const { data, error } = await db
    .from('stores')
    .insert({
      name: input.name,
      category: input.category ?? null,
      address: input.address ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      contact_number: input.contactNumber ?? null,
      opens_at: input.opensAt ?? null,
      closes_at: input.closesAt ?? null,
      open_days: input.openDays ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** The per-merchant on/off toggle. */
export async function setStoreAvailability(db: SupabaseClient, storeId: string, available: boolean) {
  const { error } = await db.from('stores').update({ is_available: available }).eq('id', storeId);
  if (error) throw error;
}

export interface StorePatch {
  name?: string;
  category?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  contactNumber?: string | null;
  logoUrl?: string | null;
  opensAt?: string | null;
  closesAt?: string | null;
  openDays?: number[] | null;
}

const ASSETS_BUCKET = 'store-assets';

function fileExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'png';
}

/** Upload a store logo to storage and save its public URL on the store. */
export async function uploadStoreLogo(db: SupabaseClient, storeId: string, file: File): Promise<string> {
  const path = `logos/${storeId}/${Date.now()}.${fileExt(file.name)}`;
  const { error: upErr } = await db.storage.from(ASSETS_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (upErr) throw upErr;
  const url = db.storage.from(ASSETS_BUCKET).getPublicUrl(path).data.publicUrl;
  const { error } = await db.from('stores').update({ logo_url: url }).eq('id', storeId);
  if (error) throw error;
  return url;
}

/** Upload a menu-item image to storage and save its public URL on the item. */
export async function uploadMenuItemImage(db: SupabaseClient, itemId: string, file: File): Promise<string> {
  const path = `items/${itemId}/${Date.now()}.${fileExt(file.name)}`;
  const { error: upErr } = await db.storage.from(ASSETS_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (upErr) throw upErr;
  const url = db.storage.from(ASSETS_BUCKET).getPublicUrl(path).data.publicUrl;
  const { error } = await db.from('menu_items').update({ image_url: url }).eq('id', itemId);
  if (error) throw error;
  return url;
}

/** Update editable fields of an existing store (e.g. pinning its map location). */
export async function updateStore(db: SupabaseClient, storeId: string, patch: StorePatch) {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.category !== undefined) row.category = patch.category;
  if (patch.address !== undefined) row.address = patch.address;
  if (patch.lat !== undefined) row.lat = patch.lat;
  if (patch.lng !== undefined) row.lng = patch.lng;
  if (patch.contactNumber !== undefined) row.contact_number = patch.contactNumber;
  if (patch.logoUrl !== undefined) row.logo_url = patch.logoUrl;
  if (patch.opensAt !== undefined) row.opens_at = patch.opensAt;
  if (patch.closesAt !== undefined) row.closes_at = patch.closesAt;
  if (patch.openDays !== undefined) row.open_days = patch.openDays;
  if (Object.keys(row).length === 0) return;
  const { error } = await db.from('stores').update(row).eq('id', storeId);
  if (error) throw error;
}

/** True when a Postgres error is a foreign-key violation (referenced by orders). */
function isFkViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '23503' || /foreign key/i.test(e?.message ?? '');
}

/** Delete a store and its whole menu. Blocked if it appears in any order. */
export async function deleteStore(db: SupabaseClient, storeId: string) {
  const { error } = await db.from('stores').delete().eq('id', storeId);
  if (error) {
    if (isFkViolation(error)) {
      throw new Error('This store has past orders and can’t be deleted. Turn it Closed instead.');
    }
    throw error;
  }
}

/** Delete a single menu item. Blocked if it appears in any order. */
export async function deleteMenuItem(db: SupabaseClient, itemId: string) {
  const { error } = await db.from('menu_items').delete().eq('id', itemId);
  if (error) {
    if (isFkViolation(error)) {
      throw new Error('This item is on past orders and can’t be deleted. Mark it Out instead.');
    }
    throw error;
  }
}

/** Set (or clear) a store's map pin. */
export async function setStoreLocation(
  db: SupabaseClient, storeId: string, loc: { lat: number; lng: number } | null,
) {
  const { error } = await db
    .from('stores')
    .update({ lat: loc?.lat ?? null, lng: loc?.lng ?? null })
    .eq('id', storeId);
  if (error) throw error;
}

/**
 * Fetch every row matching `col in (ids)`, paging past PostgREST's per-request
 * row cap (default 1000). Without this, big stores silently lose options/groups.
 */
async function fetchAllIn(
  db: SupabaseClient, table: string, col: string, ids: string[], orderCol?: string,
): Promise<unknown[]> {
  const PAGE = 1000;
  const out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select('*').in(col, ids).range(from, from + PAGE - 1);
    if (orderCol) q = q.order(orderCol);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** A store's menu: categories with their items (available items only for customers). */
export async function listMenu(db: SupabaseClient, storeId: string, availableOnly = true) {
  const cats = await db
    .from('menu_categories')
    .select('*')
    .eq('store_id', storeId)
    .order('sort_order');
  if (cats.error) throw cats.error;

  // The store's mark-up settings ride along, so callers can show the customer
  // price without a second round trip.
  const storeRow = await db.from('stores').select('markup_enabled, markup_amount').eq('id', storeId).maybeSingle();
  if (storeRow.error) throw storeRow.error;

  let itemsQuery = db.from('menu_items').select('*').eq('store_id', storeId).order('name');
  if (availableOnly) itemsQuery = itemsQuery.eq('is_available', true);
  const items = await itemsQuery;
  if (items.error) throw items.error;

  // Customization groups (e.g. Size, Sugar level) + their options, per item.
  const itemIds = (items.data ?? []).map((i) => (i as { id: string }).id);
  let optionGroups: unknown[] = [];
  let options: unknown[] = [];
  if (itemIds.length) {
    // Paginated so stores with 1000+ total options don't get silently truncated.
    optionGroups = await fetchAllIn(db, 'menu_item_option_groups', 'menu_item_id', itemIds, 'sort_order');
    options = await fetchAllIn(db, 'menu_item_options', 'menu_item_id', itemIds);
  }

  const store = (storeRow.data ?? { markup_enabled: false, markup_amount: 0 }) as
    { markup_enabled: boolean; markup_amount: number };

  // `price` stays the shelf price the admin edits and the rider pays; the
  // customer-facing figure is a separate field so nothing has to guess which
  // one it is holding.
  const withMarkup: MenuItemRow[] = (items.data ?? []).map((raw) => {
    const it = raw as Record<string, unknown>;
    const markup = effectiveMarkup(store, it as MarkupItem);
    return { ...it, markup, customer_price: roundPeso(Number(it.price ?? 0) + markup) };
  });

  return {
    categories: cats.data ?? [],
    items: withMarkup,
    optionGroups,
    options,
    markup: { enabled: store.markup_enabled, amount: Number(store.markup_amount ?? 0) },
  };
}

interface MarkupItem { markup_enabled?: boolean | null; markup_amount?: number | null }

/**
 * A menu row as callers get it: everything the table holds, plus the mark-up
 * resolved for this store and the price a customer is quoted.
 */
export type MenuItemRow = Record<string, unknown> & { markup: number; customer_price: number };

/**
 * Pesos added to one unit — the TypeScript twin of `effective_markup()`.
 *
 * Both switches must be on; the item's own amount wins over the store's. Kept
 * in step with the database function, which remains the authority when an order
 * is actually written.
 */
export function effectiveMarkup(
  store: { markup_enabled?: boolean | null; markup_amount?: number | null },
  item: MarkupItem,
): number {
  if (!store.markup_enabled) return 0;
  if (item.markup_enabled === false) return 0;
  return Math.max(0, Number(item.markup_amount ?? store.markup_amount ?? 0));
}

/** The mark-up switch and peso amount for a whole store. */
export async function setStoreMarkup(
  db: SupabaseClient, storeId: string, patch: { enabled?: boolean; amount?: number },
) {
  const row: Record<string, unknown> = {};
  if (patch.enabled !== undefined) row.markup_enabled = patch.enabled;
  if (patch.amount !== undefined) {
    if (!(patch.amount >= 0)) throw new Error('mark-up must be zero or more');
    row.markup_amount = patch.amount;
  }
  const { error } = await db.from('stores').update(row).eq('id', storeId);
  if (error) throw error;
}

/** One item's mark-up: switch it out, or give it an amount of its own. */
export async function setMenuItemMarkup(
  db: SupabaseClient, itemId: string, patch: { enabled?: boolean; amount?: number | null },
) {
  const row: Record<string, unknown> = {};
  if (patch.enabled !== undefined) row.markup_enabled = patch.enabled;
  if (patch.amount !== undefined) {
    if (patch.amount != null && !(patch.amount >= 0)) throw new Error('mark-up must be zero or more');
    row.markup_amount = patch.amount;
  }
  const { error } = await db.from('menu_items').update(row).eq('id', itemId);
  if (error) throw error;
}

export interface MenuItemPatch {
  name?: string;
  description?: string | null;
  price?: number;
  categoryId?: string | null;
}

/** Update an existing menu item's editable fields. */
export async function updateMenuItem(db: SupabaseClient, itemId: string, patch: MenuItemPatch) {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.price !== undefined) {
    if (patch.price < 0) throw new Error('price must be non-negative');
    row.price = patch.price;
  }
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
  if (Object.keys(row).length === 0) return;
  const { error } = await db.from('menu_items').update(row).eq('id', itemId);
  if (error) throw error;
}

// --- Customizations: groups (e.g. "Size", "Sugar level") and their options ---

export interface OptionGroupInput {
  itemId: string;
  name: string;
  required?: boolean;
  multiSelect?: boolean;
  sortOrder?: number;
}

/** Create a customization group on an item. */
export async function createOptionGroup(db: SupabaseClient, input: OptionGroupInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error('customization name is required');
  const { data, error } = await db
    .from('menu_item_option_groups')
    .insert({
      menu_item_id: input.itemId,
      name,
      required: input.required ?? false,
      multi_select: input.multiSelect ?? false,
      sort_order: input.sortOrder ?? 0,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateOptionGroup(
  db: SupabaseClient, groupId: string,
  patch: { name?: string; required?: boolean; multiSelect?: boolean },
) {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.required !== undefined) row.required = patch.required;
  if (patch.multiSelect !== undefined) row.multi_select = patch.multiSelect;
  if (Object.keys(row).length === 0) return;
  const { error } = await db.from('menu_item_option_groups').update(row).eq('id', groupId);
  if (error) throw error;
}

/** Delete a group and (via cascade) its options. */
export async function deleteOptionGroup(db: SupabaseClient, groupId: string) {
  const { error } = await db.from('menu_item_option_groups').delete().eq('id', groupId);
  if (error) throw error;
}

export interface OptionInput {
  itemId: string;
  groupId: string;
  groupName?: string;   // stored for reference; group_id is authoritative
  optionName: string;
  priceDelta?: number;  // extra added to the base price (may be negative)
}

/** Add an option (choice) to a customization group. */
export async function createMenuItemOption(db: SupabaseClient, input: OptionInput): Promise<string> {
  const name = input.optionName.trim();
  if (!name) throw new Error('option name is required');
  const { data, error } = await db
    .from('menu_item_options')
    .insert({
      menu_item_id: input.itemId,
      group_id: input.groupId,
      group_name: input.groupName?.trim() || null,
      option_name: name,
      price_delta: input.priceDelta ?? 0,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteMenuItemOption(db: SupabaseClient, optionId: string) {
  const { error } = await db.from('menu_item_options').delete().eq('id', optionId);
  if (error) throw error;
}

/**
 * Duplicate every customization group (and its options) from one dish onto
 * another, so the same add-ons don't have to be re-created by hand. Appends to
 * the target (existing customizations are kept). Returns how many groups were
 * copied. Prices carry over and can be edited per dish afterwards.
 */
export async function copyItemCustomizations(
  db: SupabaseClient, fromItemId: string, toItemId: string,
): Promise<{ groups: number; options: number }> {
  if (fromItemId === toItemId) return { groups: 0, options: 0 };
  const { data: groups, error: gErr } = await db
    .from('menu_item_option_groups').select('*').eq('menu_item_id', fromItemId).order('sort_order');
  if (gErr) throw gErr;
  const { data: opts, error: oErr } = await db
    .from('menu_item_options').select('*').eq('menu_item_id', fromItemId);
  if (oErr) throw oErr;

  let optionCount = 0;
  for (const g of (groups ?? []) as { id: string; name: string; required: boolean; multi_select: boolean; sort_order: number }[]) {
    const newGroupId = await createOptionGroup(db, {
      itemId: toItemId, name: g.name, required: g.required, multiSelect: g.multi_select, sortOrder: g.sort_order,
    });
    const groupOpts = ((opts ?? []) as { group_id: string | null; option_name: string; price_delta: number }[])
      .filter((o) => o.group_id === g.id);
    for (const o of groupOpts) {
      await createMenuItemOption(db, {
        itemId: toItemId, groupId: newGroupId, groupName: g.name,
        optionName: o.option_name, priceDelta: Number(o.price_delta),
      });
      optionCount++;
    }
  }
  return { groups: (groups ?? []).length, options: optionCount };
}

export async function createMenuItem(db: SupabaseClient, input: MenuItemInput) {
  if (input.price < 0) throw new Error('price must be non-negative');
  const { data, error } = await db
    .from('menu_items')
    .insert({
      store_id: input.storeId,
      category_id: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function setMenuItemAvailability(db: SupabaseClient, itemId: string, available: boolean) {
  const { error } = await db.from('menu_items').update({ is_available: available }).eq('id', itemId);
  if (error) throw error;
}

export interface MenuCategoryInput {
  storeId: string;
  title: string;
  sortOrder?: number;
}

/** Create a menu category (section) for a store, e.g. "Rice Meals", "Drinks". */
export async function createMenuCategory(db: SupabaseClient, input: MenuCategoryInput) {
  const title = input.title.trim();
  if (!title) throw new Error('category title is required');
  const { data, error } = await db
    .from('menu_categories')
    .insert({ store_id: input.storeId, title, sort_order: input.sortOrder ?? 0 })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Remove a menu category; its items are kept but become uncategorised. */
export async function deleteMenuCategory(db: SupabaseClient, categoryId: string) {
  const { error } = await db.from('menu_categories').delete().eq('id', categoryId);
  if (error) throw error;
}

export interface CopyMenuResult { categories: number; items: number }

/**
 * Copy a store's whole menu (categories, items, option groups) to another
 * branch. Categories are matched by title; `replace` wipes the target first.
 */
export async function copyStoreMenu(
  db: SupabaseClient, fromStoreId: string, toStoreId: string, replace = false,
): Promise<CopyMenuResult> {
  const { data, error } = await db.rpc('copy_store_menu', {
    p_from_store: fromStoreId, p_to_store: toStoreId, p_replace: replace,
  });
  if (error) throw error;
  return (data ?? { categories: 0, items: 0 }) as CopyMenuResult;
}

/**
 * A price a rider found different at the counter, waiting on the operator.
 *
 * The rider's correction always lands on the order they are holding — the
 * customer's bill has to match the receipt. Whether it also becomes the price
 * *every* future customer is quoted is the operator's call, and that is what
 * these are.
 */
export interface MenuPriceProposal {
  id: string;
  menuItemId: string;
  itemName: string;
  storeId: string;
  storeName: string;
  /** What our menu says today. */
  menuPrice: number;
  /** What the store is actually charging, per the most recent report. */
  actualPrice: number;
  /** How many riders have reported it. Three is a repricing; one may be a typo. */
  reports: number;
  riderName: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listMenuPriceProposals(db: SupabaseClient): Promise<MenuPriceProposal[]> {
  const { data, error } = await db
    .from('menu_price_proposals')
    .select('id, menu_item_id, store_id, menu_price, actual_price, reports, created_at, updated_at, item:menu_items(name), store:stores(name), rider:riders(name)')
    .eq('status', 'pending')
    .order('updated_at', { ascending: false });
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((row): MenuPriceProposal => {
    const item = row.item as { name?: string } | null;
    const store = row.store as { name?: string } | null;
    const rider = row.rider as { name?: string } | null;
    return {
      id: row.id as string,
      menuItemId: row.menu_item_id as string,
      itemName: item?.name ?? 'Menu item',
      storeId: row.store_id as string,
      storeName: store?.name ?? 'Store',
      menuPrice: Number(row.menu_price ?? 0),
      actualPrice: Number(row.actual_price ?? 0),
      reports: Number(row.reports ?? 1),
      riderName: rider?.name ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  });
}

/** Approve (writing the price onto the menu) or turn down a reported price. */
export async function reviewMenuPriceProposal(
  db: SupabaseClient, id: string, approve: boolean,
): Promise<void> {
  const { error } = await db.rpc('review_menu_price_proposal', { p_id: id, p_approve: approve });
  if (error) throw error;
}

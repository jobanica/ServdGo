/**
 * Bulk menu import: turn parsed CSV rows into stores, menu categories, and menu
 * items. Reuses existing stores (matched by name) so re-imports add items
 * without duplicating the store.
 */

import { groupByStore, type ParsedMenuRow } from '@ebd/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ImportSummary {
  storesCreated: number;
  storesMatched: number;
  itemsInserted: number;
}

export async function importMenuRows(
  db: SupabaseClient,
  rows: ParsedMenuRow[],
): Promise<ImportSummary> {
  const byStore = groupByStore(rows);
  const summary: ImportSummary = { storesCreated: 0, storesMatched: 0, itemsInserted: 0 };

  for (const [storeName, group] of byStore) {
    // Find an existing store by name, else create it.
    const existing = await db.from('stores').select('id').eq('name', storeName).maybeSingle();
    if (existing.error) throw existing.error;

    let storeId: string;
    if (existing.data) {
      storeId = (existing.data as { id: string }).id;
      summary.storesMatched++;
      if (group.contact) {
        await db.from('stores').update({ contact_number: group.contact }).eq('id', storeId);
      }
    } else {
      const created = await db.from('stores')
        .insert({ name: storeName, contact_number: group.contact ?? null })
        .select('id').single();
      if (created.error) throw created.error;
      storeId = (created.data as { id: string }).id;
      summary.storesCreated++;
    }

    // Resolve/create categories for this store's sections.
    const sections = [...new Set(group.items.map((i) => i.section).filter(Boolean) as string[])];
    const categoryId = new Map<string, string>();
    for (const title of sections) {
      const found = await db.from('menu_categories')
        .select('id').eq('store_id', storeId).eq('title', title).maybeSingle();
      if (found.data) categoryId.set(title, (found.data as { id: string }).id);
      else {
        const cat = await db.from('menu_categories')
          .insert({ store_id: storeId, title }).select('id').single();
        if (cat.error) throw cat.error;
        categoryId.set(title, (cat.data as { id: string }).id);
      }
    }

    // Insert the items.
    const items = group.items.map((i) => ({
      store_id: storeId,
      category_id: i.section ? categoryId.get(i.section) ?? null : null,
      name: i.item,
      price: i.price,
    }));
    const ins = await db.from('menu_items').insert(items);
    if (ins.error) throw ins.error;
    summary.itemsInserted += items.length;
  }

  return summary;
}

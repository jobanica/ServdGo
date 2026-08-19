/**
 * Menu CSV import parsing (pure). Lets the admin bulk-load stores + menu items
 * from a spreadsheet export instead of typing each one — the platform has no
 * merchant self-onboarding, so the operator enters everything.
 *
 * Expected columns (header row, any order): store, contact, section, item, price.
 * `store`, `item`, `price` are required; `contact` and `section` are optional.
 */

export interface ParsedMenuRow {
  store: string;
  contact?: string;
  section?: string;
  item: string;
  price: number;
}

export interface CsvError {
  line: number; // 1-based, including the header row
  message: string;
}

export interface ParsedMenuCsv {
  rows: ParsedMenuRow[];
  errors: CsvError[];
}

/** Split one CSV line into fields, honoring double-quoted values. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const REQUIRED = ['store', 'item', 'price'] as const;

export function parseMenuCsv(text: string): ParsedMenuCsv {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    return { rows: [], errors: [{ line: 1, message: 'Need a header row and at least one data row.' }] };
  }

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const missing = REQUIRED.filter((c) => idx(c) === -1);
  if (missing.length) {
    return { rows: [], errors: [{ line: 1, message: `Missing column(s): ${missing.join(', ')}` }] };
  }

  const rows: ParsedMenuRow[] = [];
  const errors: CsvError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]!);
    const store = f[idx('store')] ?? '';
    const item = f[idx('item')] ?? '';
    const priceRaw = f[idx('price')] ?? '';
    const cleaned = priceRaw.replace(/[^\d.]/g, '');
    const price = Number(cleaned);

    if (!store || !item) {
      errors.push({ line: i + 1, message: 'store and item are required' });
      continue;
    }
    if (cleaned === '' || Number.isNaN(price) || price < 0) {
      errors.push({ line: i + 1, message: `invalid price "${priceRaw}"` });
      continue;
    }
    const contact = idx('contact') >= 0 ? f[idx('contact')] : undefined;
    const section = idx('section') >= 0 ? f[idx('section')] : undefined;
    rows.push({ store, item, price, contact: contact || undefined, section: section || undefined });
  }

  return { rows, errors };
}

/** Group parsed rows by store for preview/import. */
export function groupByStore(rows: readonly ParsedMenuRow[]) {
  const map = new Map<string, { contact?: string; items: ParsedMenuRow[] }>();
  for (const r of rows) {
    const g = map.get(r.store) ?? { contact: r.contact, items: [] };
    if (!g.contact && r.contact) g.contact = r.contact;
    g.items.push(r);
    map.set(r.store, g);
  }
  return map;
}

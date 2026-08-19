import { useMemo, useRef, useState } from 'react';
import { parseMenuCsv, groupByStore,
  errMessage,
} from '@ebd/shared';
import { importMenuRows } from '@ebd/supabase';
import { supabase } from './lib/supabase.ts';
import { Card, peso } from './ui.tsx';

const TEMPLATE = `store,contact,section,item,price
Lutong Bahay Carinderia,0918 555 0100,Mains,Chicken Adobo,95
Lutong Bahay Carinderia,,Mains,Pork Sinigang,120
Lutong Bahay Carinderia,,Rice,Extra Rice,20
Barrio Brew,,Drinks,Wintermelon Milk Tea,90`;

export function ImportMenu({ onDone }: { onDone?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => (text.trim() ? parseMenuCsv(text) : null), [text]);
  const groups = parsed ? groupByStore(parsed.rows) : null;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setText);
  }

  async function runImport() {
    if (!supabase || !parsed) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const s = await importMenuRows(supabase, parsed.rows);
      setResult(`Imported ${s.itemsInserted} items across ${s.storesCreated + s.storesMatched} stores (${s.storesCreated} new, ${s.storesMatched} existing).`);
      setText('');
      onDone?.();
    } catch (e) {
      setError(errMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <Card title="Import stores & menu from CSV"
        action={<button onClick={() => setText(TEMPLATE)} className="text-sm font-medium text-brand-purple">Load example</button>}>
        <p className="mb-2 text-sm text-black/60">
          Columns: <code>store, contact, section, item, price</code> —
          <code> store</code>, <code>item</code>, <code>price</code> required.
          Existing stores (matched by name) gain the new items.
        </p>
        <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Paste CSV here…"
          className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-xs outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30" />
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => fileRef.current?.click()}
            className="rounded-lg px-3 py-1.5 text-sm ring-1 ring-black/10">Upload .csv</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
          {text && <button onClick={() => setText('')} className="text-sm text-black/40">Clear</button>}
        </div>
      </Card>

      {parsed && (
        <Card title="Preview">
          {parsed.errors.length > 0 && (
            <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <p className="font-medium">{parsed.errors.length} row(s) skipped:</p>
              <ul className="mt-1 list-disc pl-5">
                {parsed.errors.slice(0, 6).map((e, i) => <li key={i}>Line {e.line}: {e.message}</li>)}
              </ul>
            </div>
          )}
          {groups && groups.size > 0 ? (
            <div className="space-y-3">
              {[...groups.entries()].map(([store, g]) => (
                <div key={store} className="rounded-lg ring-1 ring-black/5">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="font-medium">{store}</span>
                    <span className="text-xs text-black/40">{g.contact ?? 'no contact'} · {g.items.length} items</span>
                  </div>
                  <ul className="divide-y divide-black/5 border-t border-black/5 text-sm">
                    {g.items.map((it, i) => (
                      <li key={i} className="flex justify-between px-3 py-1.5">
                        <span>{it.item} {it.section && <span className="text-black/30">· {it.section}</span>}</span>
                        <span>{peso(it.price)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-black/40">No valid rows to import.</p>}

          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {result && <p className="mt-3 rounded-lg bg-brand-green/10 px-3 py-2 text-sm text-green-800">✓ {result}</p>}

          {groups && groups.size > 0 && (
            <button onClick={runImport} disabled={busy || !supabase}
              className="mt-4 rounded-lg bg-brand-green px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? 'Importing…' : `Import ${parsed.rows.length} items`}
            </button>
          )}
          {!supabase && <span className="ml-3 text-xs text-black/40">Connect Supabase to import.</span>}
        </Card>
      )}
    </div>
  );
}

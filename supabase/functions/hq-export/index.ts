// A city's records as a CSV file, streamed.
//
//   GET /functions/v1/hq-export?dataset=deliveries&territory=<uuid>&from=…&to=…
//
// Datasets: deliveries, commissions, remittances, royalty, invoices.
//
// The rows are turned into lines by hq_export() in the database, which is also
// where the permission check lives — the caller's own token is used, so an
// operator gets their own city and nothing else, and the franchisor gets any of
// them. This function adds the filename and the streaming.
//
// Streamed rather than assembled: a year of deliveries is tens of megabytes,
// and the point of exporting is that it is more than a screen's worth.
//
// Deploy: supabase functions deploy hq-export

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const DATASETS = ['deliveries', 'commissions', 'remittances', 'royalty', 'invoices'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const dataset = url.searchParams.get('dataset') ?? 'deliveries';
  const territory = url.searchParams.get('territory');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (!DATASETS.includes(dataset)) {
    return new Response(JSON.stringify({ error: 'unknown_dataset', datasets: DATASETS }), {
      status: 422, headers: { ...cors, 'content-type': 'application/json' },
    });
  }
  if (!territory) {
    return new Response(JSON.stringify({ error: 'territory_required' }), {
      status: 422, headers: { ...cors, 'content-type': 'application/json' },
    });
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!auth) {
    return new Response(JSON.stringify({ error: 'unauthorised' }), {
      status: 401, headers: { ...cors, 'content-type': 'application/json' },
    });
  }

  // The caller's own token, deliberately: hq_export() decides what they may see.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  );

  const { data, error } = await db.rpc('hq_export', {
    p_dataset: dataset, p_territory: territory, p_from: from, p_to: to,
  });
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '23514' ? 422 : 500;
    return new Response(JSON.stringify({ error: error.message }), {
      status, headers: { ...cors, 'content-type': 'application/json' },
    });
  }

  const lines = (data as string[] | null) ?? [];
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // A BOM, because these are opened in Excel and a peso sign in a note
      // should not arrive as mojibake.
      controller.enqueue(encoder.encode('﻿'));
      for (const line of lines) controller.enqueue(encoder.encode(line + '\r\n'));
      controller.close();
    },
  });

  const stamp = (from ?? 'start') + '_' + (to ?? 'today');
  return new Response(stream, {
    headers: {
      ...cors,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="servdgo-${dataset}-${stamp}.csv"`,
    },
  });
});

-- Which pabili store each item comes from.
--
-- A pabili run can name several stores, but the shopping list was one flat
-- block: a rider standing in the first store saw all ten lines with no way to
-- know which two were theirs. Food orders never had this problem — their items
-- carry store_id — but a pabili store is whatever the customer typed, with no
-- row in `stores` to point at.
--
-- So point at the list on the order instead: the index of an entry in
-- orders.buy_stores. Null means "any store" — the customer didn't say, and the
-- rider picks up whatever is convenient.
alter table order_items
  add column if not exists buy_store_index int;

comment on column order_items.buy_store_index is
  'Pabili: index into orders.buy_stores for the store this item comes from. Null = any.';

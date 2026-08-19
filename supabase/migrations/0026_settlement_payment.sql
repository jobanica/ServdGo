-- Rider settlement payment details + proof of payment.
--
-- The operator's GCash/Maya destination (number, account name, QR image) is
-- shown to the rider when they settle; the rider uploads a receipt image, which
-- the admin sees before confirming.
alter table app_settings
  add column if not exists settlement_gcash_number text,
  add column if not exists settlement_gcash_name   text,
  add column if not exists settlement_qr_url        text;

alter table settlements
  add column if not exists receipt_url text;

-- Riders upload settlement receipts into store-assets/settlement-receipts/.
create policy settlement_receipt_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'settlement-receipts');
create policy settlement_receipt_update on storage.objects
  for update to authenticated
  using (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'settlement-receipts')
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'settlement-receipts');

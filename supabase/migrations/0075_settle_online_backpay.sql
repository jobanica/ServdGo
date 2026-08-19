-- The online back-pay is discharged outside the app, so close it out.
--
-- 0074 credited the rider for three deliveries where "Pay online" collected
-- nothing. Left open, those credits sit as a negative balance and come off the
-- rider's next commissions. The operator chose to hand the money over directly
-- instead, so the credits are settled here: the entries stay on the ledger as
-- the record of what was owed and why, and the balance returns to zero.

update commission_ledger cl
   set settled = true
  from orders o
 where o.id = cl.order_id
   and cl.kind = 'adjustment'
   and cl.amount < 0
   and o.payment_method = 'online'
   and o.status = 'delivered';

-- ServdGo — new cities start as leads.
--
-- Separate from 0090 because Postgres refuses to use an enum value added by
-- ALTER TYPE until the transaction that added it has committed, and every
-- migration runs inside one. Setting the default in 0090 raised
-- "unsafe use of new value" on the real deployment path.

alter table territories alter column status set default 'lead';

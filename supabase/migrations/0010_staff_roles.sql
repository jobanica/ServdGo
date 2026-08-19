-- Easy Buy Delivery — staff roles.
-- Added in their own migration so the new enum values are committed before any
-- later migration references them.

alter type user_role add value if not exists 'manager';
alter type user_role add value if not exists 'dispatcher';
alter type user_role add value if not exists 'support';

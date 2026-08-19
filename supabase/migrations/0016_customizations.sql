-- Easy Buy Delivery — flexible per-item customizations.
--
-- Each menu item can have any number of customization GROUPS (e.g. "Size",
-- "Temperature", "Sugar level"), each single- or multi-select and optionally
-- required. Options belong to a group and may add to the price.

create table if not exists menu_item_option_groups (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references menu_items (id) on delete cascade,
  name          text not null,
  required      boolean not null default false,
  multi_select  boolean not null default false,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists menu_item_option_groups_item_idx on menu_item_option_groups (menu_item_id);

alter table menu_item_option_groups enable row level security;

drop policy if exists option_groups_public_read on menu_item_option_groups;
create policy option_groups_public_read on menu_item_option_groups for select using (true);

drop policy if exists option_groups_staff_write on menu_item_option_groups;
create policy option_groups_staff_write on menu_item_option_groups
  for all using (public.is_staff()) with check (public.is_staff());

grant all on menu_item_option_groups to anon, authenticated, service_role;

-- Link options to a group; group_name becomes optional (group_id is authoritative).
alter table menu_item_options add column if not exists group_id uuid references menu_item_option_groups (id) on delete cascade;
create index if not exists menu_item_options_group_idx on menu_item_options (group_id);
alter table menu_item_options alter column group_name drop not null;

-- Migrate any existing group_name-based options into groups.
insert into menu_item_option_groups (menu_item_id, name)
select distinct menu_item_id, group_name
from menu_item_options
where group_id is null and group_name is not null;

update menu_item_options o
set group_id = g.id
from menu_item_option_groups g
where o.group_id is null and g.menu_item_id = o.menu_item_id and g.name = o.group_name;

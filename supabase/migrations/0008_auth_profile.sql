-- Easy Buy Delivery — create a profile row for every new auth user.
--
-- RLS resolves identity through profiles (auth.uid() -> profiles -> customers /
-- riders). This trigger guarantees a profile exists as soon as someone signs up
-- via OTP, so the app can then upsert their customer/rider row.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, role)
  values (new.id, 'customer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

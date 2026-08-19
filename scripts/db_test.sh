#!/usr/bin/env bash
#
# Replay every migration into a throwaway Postgres and run the SQL tests.
#
#   ./scripts/db_test.sh
#
# Needs a local PostgreSQL 16 (server binaries, not just psql). Nothing touches
# a hosted project — the cluster is created under a temporary directory and
# removed on exit.
#
# The shim below stands in for the parts of Supabase the migrations lean on:
# the anon / authenticated / service_role roles, auth.uid(), auth.users, and the
# storage schema the bucket policies attach to.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)}"
[ -n "$PGBIN" ] && PATH="$PGBIN:$PATH"

command -v initdb >/dev/null || {
  echo "initdb not found. Install the PostgreSQL server package, or set PGBIN." >&2
  exit 1
}

# initdb refuses to run as root, so drop to an unprivileged user when we are one.
RUN_AS=""
if [ "$(id -u)" -eq 0 ]; then
  RUN_AS="$(id -un postgres 2>/dev/null || echo '')"
  [ -n "$RUN_AS" ] || { echo "Running as root and no 'postgres' user to drop to." >&2; exit 1; }
  BASE="$(mktemp -d /var/lib/postgresql/dbtest.XXXXXX)"
  chown "$RUN_AS" "$BASE"
else
  BASE="$(mktemp -d)"
fi
PORT="${PGPORT:-55432}"
cleanup() {
  run "pg_ctl -D '$BASE/data' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$BASE"
}
trap cleanup EXIT

run() {
  if [ -n "$RUN_AS" ]; then su "$RUN_AS" -s /bin/bash -c "PATH=$PATH $1"; else bash -c "$1"; fi
}

run "initdb -D '$BASE/data' -U postgres --auth=trust" >/dev/null
run "pg_ctl -D '$BASE/data' -o '-p $PORT -k $BASE -c listen_addresses=' -l '$BASE/log' start" >/dev/null
for _ in $(seq 1 20); do
  psql -h "$BASE" -p "$PORT" -U postgres -c 'select 1' postgres >/dev/null 2>&1 && break
  sleep 0.5
done

PSQL="psql -h $BASE -p $PORT -U postgres -q -v ON_ERROR_STOP=1"
$PSQL -c 'create database servdgo;' postgres >/dev/null

$PSQL -d servdgo -f - <<'SQL' >/dev/null
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text, phone text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$f$;

create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null, owner uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$
  select string_to_array(name, '/')
$f$;

grant usage on schema auth, storage, public to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
grant all on auth.users to service_role;
alter default privileges in schema public grant all on tables to service_role;
create publication supabase_realtime;
SQL

count=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  $PSQL -d servdgo --single-transaction -f "$f" >/dev/null
  count=$((count + 1))
done
echo "replayed $count migrations"

fails=0
for t in "$ROOT"/supabase/tests/*.sql; do
  echo "--- $(basename "$t")"
  if out=$(psql -h "$BASE" -p "$PORT" -U postgres -d servdgo -v ON_ERROR_STOP=1 -f "$t" 2>&1); then
    echo "$out" | grep -oE 'ok  .*' | sed 's/^/    /'
    echo "    $(echo "$out" | grep -c 'ok  ') checks passed"
  else
    echo "$out" | grep -E 'ERROR|FAIL' | sed 's/^/    /'
    fails=1
  fi
done

[ $fails -eq 0 ] && echo "database tests passed" || { echo "database tests FAILED"; exit 1; }

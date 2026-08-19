#!/usr/bin/env bash
# Deploy edge functions through the Supabase Management API.
#
# The Supabase CLI is the normal way to do this. Use this when the CLI cannot
# reach api.supabase.com — inside a proxied container, for instance, where its
# Go client ignores HTTPS_PROXY and fails with a transport error.
#
#   SUPABASE_ACCESS_TOKEN=sbp_… SUPABASE_PROJECT_REF=… ./scripts/deploy_functions.sh
#   …/deploy_functions.sh create-staff v1-config     # or just these
#
# Functions that read no secrets are safe to deploy at any time. The SMS ones
# (notify-riders, notify-store, broadcast-sms) will run and fail until their
# provider secrets are set, so they are not in the default list.
set -euo pipefail

TOKEN="${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN}"
REF="${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="https://api.supabase.com/v1/projects/$REF/functions/deploy"

# Functions the browser or a partner calls without a user session. Each does its
# own authorisation, so the gateway's JWT check would only get in the way.
NO_JWT="create-staff v1-config track merchant-quote merchant-book merchant-order"

DEFAULT="create-staff v1-config hq-export track merchant-quote merchant-book merchant-order merchant-webhooks"
TARGETS=("${@:-}")
[ -z "${TARGETS[*]}" ] && read -ra TARGETS <<< "$DEFAULT"

for slug in "${TARGETS[@]}"; do
  dir="$ROOT/supabase/functions/$slug"
  if [ ! -f "$dir/index.ts" ]; then
    echo "no such function: $slug" >&2
    exit 1
  fi

  verify=true
  case " $NO_JWT " in *" $slug "*) verify=false ;; esac

  # Every file under supabase/functions/ is uploaded with its path preserved, so
  # a function's `../_shared/…` imports resolve on the other side.
  args=(-F "metadata={\"entrypoint_path\":\"$slug/index.ts\",\"name\":\"$slug\",\"verify_jwt\":$verify};type=application/json")
  while IFS= read -r file; do
    rel="${file#"$ROOT"/supabase/functions/}"
    args+=(-F "file=@$file;filename=$rel;type=application/typescript")
  done < <(find "$dir" "$ROOT/supabase/functions/_shared" -type f -name '*.ts')

  code=$(curl -sS -X POST "$API?slug=$slug" \
    -H "Authorization: Bearer $TOKEN" "${args[@]}" -o /dev/null -w '%{http_code}')
  printf '%-20s %s  (verify_jwt=%s)\n' "$slug" "$code" "$verify"
done

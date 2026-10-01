#!/usr/bin/env bash
# Dead-man's switch for the GitLab mirror: pings a healthchecks URL only while
# the mirror is healthy. Silence or a /fail ping means it needs attention.
#
# Install as a daily cron job on the server, e.g.:
#   0 9 * * * ~/docker-stack/check-mirror.sh >/dev/null 2>&1
#
# Healthy means all of:
#   - the access token is active and more than WARN_DAYS from expiry;
#   - GitLab holds the server's latest commit, or that commit is recent enough
#     that the next push-mirror.sh run will still deliver it.
#
# Without the first check, an expired token is noticed only by the push log,
# which nobody reads: the mirror silently stops being a backup.
set -uo pipefail

CONFIG="${MONITOR_CONFIG:-$HOME/.config/homeserver-monitor/config.env}"
# shellcheck source=/dev/null
[ -r "$CONFIG" ] && . "$CONFIG"

URL="${MIRROR_HC_URL:-}"
WARN_DAYS="${MIRROR_WARN_DAYS:-30}"
DATA_DIR="${OBSYDIAN_DATA_DIR:-/mnt/docker/appdata/obsydian-sync/data}"
CRED="${OBSYDIAN_MIRROR_CREDENTIALS:-$HOME/.config/obsydian-mirror/credentials}"
# push-mirror.sh runs every 15 minutes; an hour allows for a few failed runs.
MAX_UNPUSHED_SECS="${MIRROR_MAX_UNPUSHED_SECS:-3600}"

problems=""
report=""
problem() { problems="${problems}$1"$'\n'; }

# --- token -------------------------------------------------------------------
token=$(sed -nE 's#^https://oauth2:([^@]+)@gitlab\.com$#\1#p' "$CRED" 2>/dev/null)
if [ -z "$token" ]; then
  problem "no token in $CRED"
else
  # The header comes from a file descriptor, not argv: an argument is visible
  # to every local user in `ps`.
  body=$(curl -sS -m 15 --retry 3 -w '\n%{http_code}' \
    -H @<(printf 'PRIVATE-TOKEN: %s\n' "$token") \
    https://gitlab.com/api/v4/personal_access_tokens/self 2>&1)
  unset token
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  case "$status" in
    200)
      active=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("active"))')
      expires=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("expires_at") or "")')
      if [ "$active" != "True" ]; then
        problem "token is no longer active (revoked or expired)"
      elif [ -n "$expires" ]; then
        days=$(( ( $(date -d "$expires" +%s) - $(date +%s) ) / 86400 ))
        report="${report}token expires $expires ($days days)"$'\n'
        if [ "$days" -le "$WARN_DAYS" ]; then
          problem "token expires $expires, in $days days: create a new one and rerun the mirror setup"
        fi
      else
        report="${report}token has no expiry date"$'\n'
      fi
      ;;
    401) problem "GitLab rejects the token (expired or revoked): create a new one and rerun the mirror setup" ;;
    *)   problem "could not ask GitLab about the token (HTTP $status)" ;;
  esac
fi

# --- push freshness ----------------------------------------------------------
if cd "$DATA_DIR" 2>/dev/null && local_head=$(git rev-parse HEAD 2>/dev/null); then
  remote_head=$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
  if [ "$local_head" = "$remote_head" ]; then
    report="${report}GitLab is up to date at ${local_head:0:7}"$'\n'
  else
    age=$(( $(date +%s) - $(git log -1 --format=%ct HEAD) ))
    if [ "$age" -gt "$MAX_UNPUSHED_SECS" ]; then
      problem "GitLab is behind: ${local_head:0:7} has waited $((age / 60)) minutes; see ~/.local/state/obsydian-mirror.log"
    else
      report="${report}${local_head:0:7} not pushed yet ($((age / 60)) minutes old)"$'\n'
    fi
  fi
else
  problem "no git history in $DATA_DIR"
fi

printf '%s%s' "$report" "$problems"

[ -n "$URL" ] || { echo "no MIRROR_HC_URL configured"; [ -z "$problems" ]; exit; }

if [ -n "$problems" ]; then
  printf '%s%s' "$problems" "$report" \
    | curl -fsS -m 15 --retry 3 --data-binary @- "$URL/fail" >/dev/null 2>&1
  exit 1
fi

printf 'mirror healthy\n%s' "$report" \
  | curl -fsS -m 15 --retry 3 --data-binary @- "$URL" >/dev/null 2>&1

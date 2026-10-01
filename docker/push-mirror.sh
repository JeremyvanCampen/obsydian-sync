#!/usr/bin/env bash
# Pushes the vault's git history to the private GitLab mirror.
#
# Install as a cron job on the server, e.g. every 15 minutes:
#   */15 * * * * ~/docker-stack/push-mirror.sh >> ~/.local/state/obsydian-mirror.log 2>&1
#
# Deliberately separate from the server process: a failed push must never be
# able to fail a sync. If GitLab is unreachable the next run catches up.
set -euo pipefail

DATA_DIR="${OBSYDIAN_DATA_DIR:-/mnt/docker/appdata/obsydian-sync/data}"
REMOTE="${OBSYDIAN_MIRROR_REMOTE:-origin}"

if [[ ! -d "$DATA_DIR/.git" ]]; then
  echo "$(date -Is) no repository at $DATA_DIR — is git mirroring enabled in config.toml?"
  exit 1
fi

cd "$DATA_DIR"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  cat >&2 <<'MSG'
No mirror remote configured. Create a private project on gitlab.com and a
Project Access Token with the write_repository scope, then:

  # The token goes OUTSIDE the data directory. /mnt/docker/appdata is what the
  # nightly backup job replicates to off-site storage — a write_repository
  # credential in .git/config there would be copied off-site in cleartext, and
  # it is the one piece of this system that is not already ciphertext.
  mkdir -p ~/.config/obsydian-mirror
  umask 077
  printf 'https://oauth2:%s@gitlab.com\n' '<TOKEN>' > ~/.config/obsydian-mirror/credentials
  chmod 600 ~/.config/obsydian-mirror/credentials

  cd /mnt/docker/appdata/obsydian-sync/data
  git remote add origin https://gitlab.com/you/obsidian-vault.git
  git config credential.helper "store --file=$HOME/.config/obsydian-mirror/credentials"

No device ever talks to GitLab; only this script does.
MSG
  exit 1
fi

# A token pasted into the remote URL ends up in .git/config, which a backup job may copy
# off-site. Refuse rather than let that sit there unnoticed.
#
# Any userinfo at all in an http(s) URL. A GitLab PAT is normally used as
# https://glpat-TOKEN@gitlab.com/... with no colon, so requiring one here would
# miss the most common form. An SSH remote (git@gitlab.com:you/repo.git) is not
# an http(s) URL and is correctly allowed.
#
# The URL is captured first rather than piped: grep exits on the first match,
# git takes a SIGPIPE, and `set -o pipefail` then reports the pipeline as
# failed — so the check would silently evaluate false and let the token through.
remote_url=$(git remote get-url "$REMOTE")
if printf '%s' "$remote_url" | grep -qE '^https?://[^/@]*@'; then
  echo "$(date -Is) refusing to push: the remote URL embeds a credential." >&2
  echo "  It is inside the backed-up tree and would be copied off-site in cleartext." >&2
  echo "  Move it to a credential file — see the instructions above by removing the remote." >&2
  exit 1
fi

# Nothing to do if the working tree has no commits yet.
if ! git rev-parse HEAD >/dev/null 2>&1; then
  echo "$(date -Is) no commits yet"
  exit 0
fi

if git push --quiet "$REMOTE" HEAD:main; then
  echo "$(date -Is) pushed $(git rev-parse --short HEAD)"
else
  # Non-fatal on purpose: the mirror is a backup, not the source of truth.
  echo "$(date -Is) push failed; will retry on the next run"
  exit 0
fi

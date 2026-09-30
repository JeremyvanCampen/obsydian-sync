# Setting up Obsydian Sync

Everything here needs a human: a real terminal for `sudo`, a browser for GitLab,
and devices to install on. Nothing in this file has been run — it is the
handover, not a record.

Order matters. **Do not point this at your real vault until step 5 passes.**

---

## 1. Try it locally first

Build and run the server on your desktop, against a throwaway vault.

```sh
cd ~/Code/Obsydian-sync
cargo build --release --package obsydian-sync-server
cargo build --release --package obsydian-restore

# A token for this device. Generate a real one; this is just the shape.
TOKEN=$(head -c 32 /dev/urandom | base64)
echo "token: $TOKEN"          # paste into the plugin later
DIGEST=$(printf '%s' "$TOKEN" | ./target/release/obsydian-sync-server --hash-token)

mkdir -p /tmp/obsydian-test/data
cat > /tmp/obsydian-test/config.toml <<EOF2
bind = "127.0.0.1:8787"
data_dir = "/tmp/obsydian-test/data"

[[devices]]
id = "desktop"
token_sha256 = "$DIGEST"
EOF2

./target/release/obsydian-sync-server /tmp/obsydian-test/config.toml
```

Then build and install the plugin into a **copy** of your vault:

```sh
cd plugin && npm install && npm run build

# A scratch vault, not ~/your-vault.
cp -r ~/your-vault /tmp/test-vault

# Include an empty note: a sealed empty file is the minimum legal size, and
# that boundary was wrong in both implementations until it was tested for.
: > "/tmp/test-vault/Empty note.md"
mkdir -p /tmp/test-vault/.obsidian/plugins/obsydian-sync
cp main.js manifest.json /tmp/test-vault/.obsidian/plugins/obsydian-sync/
```

Open `/tmp/test-vault` in Obsidian, enable the plugin in Community Plugins, and
in its settings set the server to `http://127.0.0.1:8787`, paste the token and a
passphrase. **Write the passphrase into your password manager now** — it cannot
be recovered or changed later.

Press **Test connection**. It will say the vault has no passphrase set yet.
Press **Initialize**. Then run *Sync now* from the command palette.

### What to check

- `Obsydian Sync` in the status bar turns to `✓ Synced (n files)`.
- `grep -rF ".md" /tmp/obsydian-test/data/` returns **nothing**, and so does the
  same for a note title and some note text. If any of it is greppable there,
  stop — the encryption is not working.

  Use `-F`. Without it a `.` is a regex wildcard that matches any byte, so
  `grep -r ".md"` "finds" `.md` inside base64 and reports a leak that is not
  there. (It did exactly that the first time this check was run.)
- Make a second copy of the vault, install the plugin there with a second token,
  and run the deletion scenario by hand: create a note on A, sync both, delete
  it on B, sync B, sync A, then **sync A again**. It must stay gone.

---

## 2. The restore drill

Do this before trusting the system with real notes, and repeat it occasionally.
An untested backup is not a backup.

```sh
./target/release/obsydian-restore --data-dir /tmp/obsydian-test/data info
./target/release/obsydian-restore --data-dir /tmp/obsydian-test/data verify
./target/release/obsydian-restore --data-dir /tmp/obsydian-test/data \
  restore --out /tmp/obsydian-restored

diff -r /tmp/test-vault /tmp/obsydian-restored   # expect only .obsidian noise
```

`verify` exits non-zero if anything is missing, undecryptable, or the wrong
size. That exit status is the thing to check from a script.

---

## 3. Deploy to the home server

Per `[[Agent guide]]`: use `192.168.1.10` for SSH (the tailnet path demands a
browser re-auth and hangs), and anything needing `sudo` must be run by you in a
real terminal.

```sh
# Copy the source over and build the image there.
rsync -a --exclude target --exclude node_modules \
  ~/Code/Obsydian-sync/ you@192.168.1.10:~/obsydian-sync/

ssh you@192.168.1.10
cd ~/obsydian-sync
docker build -f docker/Dockerfile -t obsydian-sync:latest .   # the compose fragment expects this tag

mkdir -p /mnt/docker/appdata/obsydian-sync/{data,config}
```

Write `/mnt/docker/appdata/obsydian-sync/config/config.toml` using
`server/config.example.toml` as the model. **Keep `bind = "0.0.0.0:8787"`** —
that is the address inside the container, where the host's tailnet IP does not
exist; the compose file's `ports:` mapping is what restricts exposure — **one device entry per device**,
each with its own token, so any single one can be revoked:

```sh
printf '%s' '<the token for that device>' | \
  docker run --rm -i obsydian-sync:latest --hash-token
```

Set `[git] enabled = true` so the data directory gets a real commit history.

Then add the service. Back up the compose file first, and validate before
applying:

```sh
cp ~/docker-stack/docker-compose.yml ~/backups/docker-compose.yml.$(date +%Y%m%d-%H%M%S)
# paste docker/compose.fragment.yml into ~/docker-stack/docker-compose.yml
cd ~/docker-stack && docker compose config -q && docker compose up -d obsydian-sync
docker logs obsydian-sync
```

### Check the binding, because this is the part that bites

```sh
ss -tulpn | grep 8787      # must show 100.x.y.z:8787, never 0.0.0.0:8787
```

A bare `"8787:8787"` publishes to the whole LAN, and UFW will not stop it —
Docker's DNAT rules run before UFW's INPUT chain. **Do not add an NPM proxy
host.** Public proxy hosts stay exactly two: `jellyfin` and `requests`.

---

## 4. The GitLab mirror

Create a **private** project on gitlab.com, then a Project Access Token with the
`write_repository` scope.

**The token must not go in the remote URL.** `/mnt/docker/appdata` is exactly
what your backup job replicates to off-site storage, so a credential in
`.git/config` would be copied off-site in cleartext — and it is the one piece of
this system that is not already ciphertext. Keep it outside that tree:

```sh
mkdir -p ~/.config/obsydian-mirror
umask 077
printf 'https://oauth2:%s@gitlab.com\n' '<TOKEN>' > ~/.config/obsydian-mirror/credentials
chmod 600 ~/.config/obsydian-mirror/credentials

cd /mnt/docker/appdata/obsydian-sync/data
git remote add origin https://gitlab.com/you/obsidian-vault.git
git config credential.helper "store --file=$HOME/.config/obsydian-mirror/credentials"

cp ~/obsydian-sync/docker/push-mirror.sh ~/docker-stack/
crontab -e    # */15 * * * * ~/docker-stack/push-mirror.sh >> ~/.local/state/obsydian-mirror.log 2>&1
```

`push-mirror.sh` refuses to run if it finds a credential embedded in the remote
URL, rather than letting it sit there unnoticed.

No device ever talks to GitLab; only this script does. What is pushed is
ciphertext, so the mirror is useless to GitLab and complete to you.

Note the data directory is also inside `/mnt/docker/appdata`, so the existing
your backup tool job already backs it up nightly to `/mnt/series/your backup tool` and to off-site storage
B2 — the GitLab mirror is a second off-site copy, not the only one.

---

## 5. Devices

Every device must be on the tailnet. If you use tailnet lock, each new device must be signed by an existing signing
node after it joins —

```sh
tailscale lock sign nodekey:<from the admin console Machines page>
```

Then on each device, copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/obsydian-sync/` (or the `plugins/` folder inside your
vault's config folder, if you have changed it in Obsidian), enable it, and set the server to
`http://100.x.y.z:8787` with **that device's own token** and the same
passphrase.

Add devices one at a time and let each converge before adding the next.

---

## 6. Migrating off remotely-save

1. Take a full copy of the vault first: `cp -r ~/your-vault ~/vault-backup-$(date +%F)`.
2. Run both plugins side by side on one device for a week.
3. Run the restore drill again, against the real server's data directory.
4. Disable remotely-save everywhere, verify all five devices converge, then
   remove it.

---

## Things that will look like bugs and are not

- **Sync only runs while Tailscale is connected.** The vault is local-first and
  usable offline; it catches up on the next trigger.
- **On mobile, sync happens when you open the app.** iOS and Android suspend
  background apps. Sync-on-focus is the design, not a workaround.
- **The first sync of `.obsidian` moves about 9 MB.** Mostly Excalidraw's plugin
  code. It dedupes by content afterwards.
- **A sync can stop and ask before deleting a lot of files.** That guard exists
  because losing the base state makes every path look untracked. Read what it
  says before confirming.

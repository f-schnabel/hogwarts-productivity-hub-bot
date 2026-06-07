# Drizzle Gateway (Docker-less) on the OCI VPS

Runs [Drizzle Gateway](https://orm.drizzle.team/drizzle-gateway/overview) as a
native binary under systemd so the Postgres DB can be browsed/edited from
mobile, kept off the public internet and behind Cloudflare Access.

**Verified against the docs (2025-12-16):**

| Item | Value |
|------|-------|
| Current version | `1.2.0` (changelog dated 16/12/2025) |
| ARCH | `linux-arm64` (OCI Ampere A1) |
| Binary URL | `https://pub-e240a4fd7085425baf4a7951e7611520.r2.dev/drizzle-gateway-1.2.0-linux-arm64` |
| Env vars (the only ones documented) | `PORT`, `STORE_PATH`, `MASTERPASS` |
| Bind-host / HOST var | **none exists** — Gateway always listens on `0.0.0.0:4983` |
| Access | Caddy → `gateway.schnabel.dev` → `127.0.0.1:4983`, behind Cloudflare Access |
| DB / schema | `hogwarts_db` / `public` |
| DDL | allowed (`GRANT CREATE ON SCHEMA public`) |

> Re-verify the version/URL before every install — the docs URL is the source of
> truth, not this table: <https://orm.drizzle.team/drizzle-gateway/overview>

## ⚠️ Security model — read this

The Gateway binary has **no option to bind to `127.0.0.1`** (only `PORT`,
`STORE_PATH`, `MASTERPASS` exist). It therefore listens on **`0.0.0.0:4983`**.
Caddy reaching it on `127.0.0.1:4983` works, but the port is kept off the
internet **only by the firewall**. So:

- **Do NOT** add an OCI ingress rule or a `ufw allow` for 4983.
- Confirm OCI's default-deny inbound and `ufw` keep 4983 unreachable from off-box
  (verification step below).
- `gateway.schnabel.dev` **must** sit behind **Cloudflare Access (Zero Trust)** —
  `MASTERPASS` alone is not adequate protection for a public hostname. This is a
  **manual dashboard step you do**, not code.
- We intentionally do **not** set `IPAddressDeny=any` in the unit: the Gateway
  phones home to its licensing server on first run, which that would block.

## Files in this folder

| File | Purpose |
|------|---------|
| `drizzle-gateway.service` | systemd unit (symlinked into `/etc/systemd/system/`) |
| `deploy.sh` | idempotent installer: user, binary, dirs, secret, unit, caddy reload |
| `role.sql` | scoped `drizzle_admin` Postgres role (DML + DDL, non-superuser) |
| `README.md` | this runbook |

## Deploy (on the VPS)

### 1–5. Binary, user, dirs, secret, unit

```bash
sudo config/drizzle-gateway/deploy.sh
```

`deploy.sh` is idempotent and:
- creates the `drizzle` system user (home `/opt/drizzle-gateway`, `nologin`),
- downloads the pinned binary to `/opt/drizzle-gateway/gateway` (`+x`, `drizzle:drizzle`), prints its sha256,
- creates `/var/lib/drizzle-gateway` (`drizzle:drizzle`, `0700`),
- generates `MASTERPASS` into `/etc/drizzle-gateway.env` (`root:root`, `0600`) **and prints it once** — save it, then clear scrollback,
- symlinks the unit, `daemon-reload`, `enable --now`,
- validates + reloads Caddy if installed.

The unit symlink is also wired into `config/install.sh`, so a normal
`install.sh` run keeps it linked.

### 2b. Scoped Postgres role (run as the postgres admin)

The password is passed as a psql variable so it never hits shell history or disk:

```bash
PW="$(openssl rand -base64 24)"
sudo -u postgres psql -d hogwarts_db -v gw_password="$PW" -f config/drizzle-gateway/role.sql
echo "drizzle_admin password: $PW"   # save it, hand it over, then: clear / history -c
```

Grants: `CONNECT`, schema `USAGE`, `SELECT/INSERT/UPDATE/DELETE` on all + future
tables, sequence `USAGE/SELECT/UPDATE`, and `CREATE ON SCHEMA public` (DDL).
The role is forced `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`.

This password is **not** placed in systemd — you enter it in the Gateway UI
(step 6) and it is persisted under `STORE_PATH`.

### 5b. Caddy + Cloudflare Access

`config/caddy/hogwarts.caddyfile` now contains the `gateway.schnabel.dev` block.
`deploy.sh` reloads Caddy; otherwise:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Then verify HTTPS resolves with a valid cert (the UI needs a secure context):

```bash
curl -sSI https://gateway.schnabel.dev | head -n1
```

**Manual, by you (required):** in the Cloudflare Zero Trust dashboard, put
`gateway.schnabel.dev` behind an Access policy (your identity only). Not code.

### 6. First-run linking (manual, by you)

1. Open **https://gateway.schnabel.dev** (through Cloudflare Access).
2. On first load the Gateway links to its licensing server via **GitHub login** —
   complete it. (Gateway/Studio is **closed-source**, phones home, and has a paid
   subscription after a trial — confirm current pricing before relying on it.)
3. Add a DB connection in the UI:
   - Host `127.0.0.1`, Port `5432`, Database `hogwarts_db`
   - User `drizzle_admin`, Password = the `$PW` from step 2b
   - **SSL off** (localhost). Connections persist under `STORE_PATH`.

## 7. Verification checklist

```bash
# enabled + survives restart
systemctl is-enabled drizzle-gateway          # -> enabled
sudo systemctl restart drizzle-gateway && systemctl is-active drizzle-gateway

# unit is a symlink into the service-defs folder
ls -l /etc/systemd/system/drizzle-gateway.service   # -> ... -> <repo>/config/drizzle-gateway/drizzle-gateway.service

# secrets file perms + location (NOT inside the repo)
stat -c '%a %U:%G %n' /etc/drizzle-gateway.env      # -> 600 root:root /etc/drizzle-gateway.env

# STORE_PATH persists (connections survive a restart) — check after step 6
sudo ls -la /var/lib/drizzle-gateway

# 4983 NOT reachable from outside: list rules + test from another host
sudo ufw status verbose | grep -i 4983 || echo "no ufw rule for 4983 (good)"
# OCI: confirm no ingress rule for 4983 in the VCN security list / NSG (console)
# From a DIFFERENT machine:  nc -zv <vps-public-ip> 4983   -> should time out/refuse

# role is not a superuser
sudo -u postgres psql -tAc "SELECT rolsuper FROM pg_roles WHERE rolname='drizzle_admin';"  # -> f

# access path end-to-end
curl -sSI https://gateway.schnabel.dev | head -n1   # -> HTTP/2 200/302 with valid cert
```

## Rollback

```bash
sudo systemctl disable --now drizzle-gateway
sudo rm /etc/systemd/system/drizzle-gateway.service
sudo systemctl daemon-reload
# optional: sudo rm -rf /opt/drizzle-gateway /var/lib/drizzle-gateway /etc/drizzle-gateway.env
# optional DB: sudo -u postgres psql -d hogwarts_db -c 'DROP ROLE drizzle_admin;'
# remove the gateway.schnabel.dev block from caddy/hogwarts.caddyfile, reload caddy
```

## Notes

- Closed-source + phone-home + paid-after-trial. If that's a dealbreaker, fully
  self-contained alternatives are **pgweb** or **CloudBeaver** (out of scope).

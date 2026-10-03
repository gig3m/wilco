# Installing Wilco

Wilco is a single-user web email client over JMAP (tested against Fastmail).
It runs as one container with a SQLite cache and needs a TLS reverse proxy
in front of it with **two hostnames**.

## Prerequisites

- Docker Engine with Compose v2 (`docker compose version`).
- Two DNS names on the same proxy, e.g. `mail.example.com` (the app) and
  `mailbody.example.com` (message bodies). They must be different hosts:
  the second is the sandbox where a sender's HTML is rendered, isolated by
  origin. HTTP does not work: session cookies are `Secure` and every
  write compares the browser's `Origin` to `WILCO_BASE_URL`.
- A JMAP API token per account (Fastmail: Settings → Privacy & Security →
  Integrations → API tokens; scope "Mail").

## 1. Bootstrap

    git clone https://github.com/gig3m/wilco.git wilco && cd wilco
    ./bootstrap.sh https://mail.example.com https://mailbody.example.com
    docker compose up -d
    curl -s http://127.0.0.1:8794/healthz

`bootstrap.sh` creates `secrets/master-key` (back it up — it seals the
account tokens; without it they are unrecoverable and you re-enter them),
writes `.env` from `.env.example`, builds the image and asks for the
web login password. Re-running it is safe; it only fills in what is missing.

The password prompt needs a terminal (it asks twice, without echo). Running
it non-interactively — over ssh with no tty, or from a script — pipe the
password in instead: `echo 'your-password' | ./bootstrap.sh https://... https://...`.

The `curl` above answers `503` with `{"ok":false,"error":"no accounts
configured"}` at this point. That is expected, not a failure — it stays that
way until you add the first account in step 3.

To use a published image instead of building, set `WILCO_IMAGE=ghcr.io/gig3m/wilco:<tag>` in `.env` before running the bootstrap.

## 2. Reverse proxy

Both names go to the same container port. Caddy:

    mail.example.com {
        reverse_proxy 127.0.0.1:8794 {
            flush_interval -1     # /api/events is server-sent events
        }
    }
    mailbody.example.com {
        reverse_proxy 127.0.0.1:8794
    }

nginx: `proxy_buffering off;` and `proxy_http_version 1.1;` on the app host,
for `/api/events`; no caching on the body host. The container decides by the
`Host` header which of the two it is serving, so nothing else is needed.

Nginx Proxy Manager: enable *Websockets Support* on the app host and put only
`proxy_buffering off;` in its Advanced tab. NPM already emits
`proxy_http_version 1.1`, and repeating it takes the host offline with a
duplicate-directive error.

## 3. Adding an account

In the app: sidebar "+" → address, token, and an endpoint only if yours is
not discoverable (it is derived from the address, falling back to Fastmail's).
Wilco checks the token before storing it and starts syncing straight away;
no restart.

Or headless. This writes to the database directly, so the running container
needs a recreate to pick the account up:

    WILCO_ACCOUNT_TOKEN='<token>' docker compose run --rm -e WILCO_ACCOUNT_TOKEN wilco \
      node scripts/add-account.ts --key personal --label Personal --commit
    docker compose up -d --force-recreate wilco

The key is permanent (it is half of every message id). Initial sync of a
large mailbox takes minutes to hours; `/healthz` reports per-account state.

## Backups

- `secrets/master-key` and `.env` (the password hash). Small; keep off-box.
- The `wilco-data` volume: `docker run --rm -v wilco_wilco-data:/data -v "$PWD":/out alpine tar czf /out/wilco-data.tgz -C /data .`
  It holds the message cache AND the sealed tokens, so treat it as sensitive.
  `wilco_wilco-data` assumes your checkout directory is named `wilco` (Compose
  derives the volume name from the project directory); if yours is named
  differently, substitute `<your-directory-name>_wilco-data` or check the
  real name with `docker volume ls`.

## Changing the password

    docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
      -e WILCO_ENV_PATH=/work/.env wilco:local node /work/scripts/set-password.ts --commit
      # wilco:local is the default WILCO_IMAGE (from .env.example) -- use your
      # WILCO_IMAGE tag instead if you set one
    docker compose up -d wilco      # `restart` does not re-read .env

The script backs up the previous hash beside `.env` as `.env.bak-<timestamp>`;
delete it once you've confirmed the new password works.

## Upgrading

Building from source:

    git pull && docker compose build wilco && docker compose up -d wilco

Using a published image (`WILCO_IMAGE=ghcr.io/gig3m/wilco:<tag>` in `.env`):

    docker compose pull wilco && docker compose up -d wilco

Schema migrations run at boot. Expect `/healthz` to answer 503 for the
first seconds after any restart, until the first sync pass completes.

**Running a second instance on the same host** (e.g. staging) needs a
compose override — `docker-compose.yml` pins `container_name: wilco`, so a
second stack on the same Docker host must override that name (and its host
port) or the second `up` will collide with the first.

## Troubleshooting

- Container restart-loops: `secrets/master-key` missing, unreadable, or not
  the key this database was sealed with. `docker compose logs wilco`.
- Container restart-loops and `secrets/master-key` looks fine: the container
  always reads it as **uid 1000** (the image's `USER node`), regardless of
  who ran `bootstrap.sh`. If your uid isn't 1000, the file may be unreadable
  to the container even though you can read it fine yourself. Fix:
  `sudo chown 1000 secrets/master-key` (the file stays 0600).
- Login answers 403: either you are reaching the app by IP or by a name that
  is not `WILCO_BASE_URL` (the browser's `Origin` must match it exactly), or
  the client omitted the `x-wilco-csrf` header — the bundled SPA always sends
  it, so this only bites a hand-written client or a raw `curl` login.
- Login answers 401 with the right password: the hash in `.env` lost its
  `$$` doubling. Re-run the password script.
- Messages show but bodies are blank: `WILCO_BODY_BASE_URL` is not proxied
  to the container, or is the same host as `WILCO_BASE_URL`.

#!/usr/bin/env bash
# First-run setup for Wilco. Idempotent: re-running never overwrites a key or
# a password that already exists; it only fills in what is missing.
#
#   ./bootstrap.sh https://mail.example.com https://mailbody.example.com
#
# Needs: docker (compose v2), openssl or /dev/urandom. No host Node: the
# password hash is computed inside the Wilco image.
#
# The password prompt (step 4) needs a TTY for its no-echo, ask-twice
# confirmation. When stdin is not a TTY (piped input, non-interactive CI),
# this script falls back to reading one line from stdin and passing it to
# set-password.ts via --stdin instead.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <WILCO_BASE_URL> <WILCO_BODY_BASE_URL>" >&2
  echo "  two DIFFERENT https origins, e.g. https://mail.example.com https://mailbody.example.com" >&2
  exit 2
fi
base="$1"; body="$2"
for u in "$base" "$body"; do
  [[ "$u" == https://* ]] || { echo "error: $u is not https://" >&2; exit 2; }
done
[[ "$base" != "$body" ]] || { echo "error: the two origins must differ (message HTML is sandboxed on the second)" >&2; exit 2; }

# 1. master key -- file, 0600, never in .env (see docker-compose.yml)
mkdir -p secrets && chmod 700 secrets

# The container always reads this file as uid 1000 (USER node in the image),
# regardless of who runs bootstrap.sh. On a host where the invoking user is
# not uid 1000, a key owned by the invoking user is unreadable to the
# container and it restart-loops on first run. Fix ownership when we can
# (root can chown to any uid); otherwise tell the operator the exact command.
ensure_master_key_owner() {
  [[ "$(id -u)" == "1000" ]] && return 0
  if chown 1000 secrets/master-key 2>/dev/null; then
    return 0
  fi
  echo "warning: secrets/master-key is not owned by uid 1000, and this user" >&2
  echo "  cannot chown it. The container reads it as uid 1000 and will" >&2
  echo "  restart-loop until you run:" >&2
  echo "    sudo chown 1000 secrets/master-key   # the container reads it as uid 1000; the file stays 0600" >&2
}

if [[ -s secrets/master-key ]]; then
  echo "secrets/master-key exists -- keeping it"
  ensure_master_key_owner
else
  if command -v openssl >/dev/null; then openssl rand -hex 32 > secrets/master-key
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > secrets/master-key; echo >> secrets/master-key; fi
  chmod 600 secrets/master-key
  ensure_master_key_owner
  echo "wrote secrets/master-key -- BACK THIS UP. Without it the stored account tokens are unreadable."
fi

# 2. .env from the example, with the two origins filled in
if [[ -f .env ]]; then
  echo ".env exists -- keeping it (edit WILCO_BASE_URL / WILCO_BODY_BASE_URL by hand if they changed)"
else
  sed -e "s#^WILCO_BASE_URL=.*#WILCO_BASE_URL=$base#" \
      -e "s#^WILCO_BODY_BASE_URL=.*#WILCO_BODY_BASE_URL=$body#" .env.example > .env
  chmod 600 .env
  echo "wrote .env"
fi

# 3. image
image="$(grep -E '^WILCO_IMAGE=' .env | cut -d= -f2- || true)"; image="${image:-wilco:local}"
if [[ "$image" == "wilco:local" ]]; then
  echo "building $image (first build compiles the web client; a minute or two)"
  docker compose build wilco
else
  docker pull "$image"
fi

# 4. login password -- hashed inside the image, written to .env with doubled dollars
if grep -qE '^WILCO_PASSWORD_HASH=.+' .env; then
  echo "WILCO_PASSWORD_HASH already set -- keeping it (scripts/set-password.ts changes it)"
else
  if [[ -t 0 ]]; then
    echo "choose the web login password (min 8 characters):"
    docker run --rm -it --user "$(id -u):$(id -g)" \
      -v "$PWD:/work" -w /work -e WILCO_ENV_PATH=/work/.env \
      "$image" node /work/scripts/set-password.ts --commit
  else
    # No TTY (piped/non-interactive): read one line from stdin and hand it
    # to set-password.ts's --stdin path instead of the ask-twice prompt.
    # `|| true` on the read: input with no trailing newline makes `read`
    # return non-zero even though $password is populated correctly, which
    # would otherwise trip `set -e` here. Feed it through a pipe rather than
    # a herestring -- bash may materialise a herestring as a temp file, and
    # `set -o pipefail` (part of `set -euo pipefail` above) still makes the
    # docker run's exit status fail the script.
    read -r password || true
    printf '%s\n' "$password" | docker run --rm -i --user "$(id -u):$(id -g)" \
      -v "$PWD:/work" -w /work -e WILCO_ENV_PATH=/work/.env \
      "$image" node /work/scripts/set-password.ts --commit --stdin
  fi
  rm -f .env.bak-*
fi

cat <<EOF

Ready. Next:
  docker compose up -d
  curl -s http://\$(grep ^WILCO_BIND= .env | cut -d= -f2):\$(grep ^WILCO_HOST_PORT= .env | cut -d= -f2)/healthz
    # answers 503 "no accounts configured" until step 3 -- expected, not a failure
Then put a TLS proxy in front (INSTALL.md, "Reverse proxy") and add an account
(INSTALL.md, "Adding an account").
EOF

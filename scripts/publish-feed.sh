#!/usr/bin/env bash
# Publish the feed's artefacts to Nexus, for the Ansible playbook to install
# from (NAKTV-9).
#
# Three artefacts, two of them third-party:
#
#   third-party/go2rtc/<ver>/go2rtc_linux_amd64      upstream prebuilt binary
#   third-party/librespot/<ver>/librespot_linux_amd64   built by us — see below
#   naktv-feed/<ver>/naktv-feed-<ver>.tar.gz         feed/ itself
#
# librespot publishes NO release binaries, for any architecture, and is not in
# Debian or Ubuntu. It has to be compiled. Doing that on the target means a
# Rust toolchain on a box that otherwise needs none, so it is built once in a
# container and vendored here instead:
#
#   docker run --rm -v /tmp/librespot-build:/out rust:1-slim bash -c '
#     apt-get update -qq && apt-get install -y -qq build-essential pkg-config
#     cargo install librespot --version 0.8.0 --locked \
#       --no-default-features --features rustls-tls-webpki-roots,with-libmdns \
#       --root /out'
#
# Those features are not arbitrary. `with-libmdns` is a DEFAULT feature and
# carries Connect discovery — drop it and the device never appears in Spotify.
# `rodio-backend` is dropped because the pipe backend is never feature-gated
# and rodio would drag in ALSA headers. `native-tls` is swapped for rustls so
# the build needs no OpenSSL headers.
#
# The repo is writePolicy=ALLOW_ONCE, so a version is immutable: re-publishing
# an existing path fails rather than silently changing what past deploys
# install. Bump the version instead.
#
# Usage:
#   scripts/publish-feed.sh <feed-version> [--librespot /path/to/librespot]
#
# Requires the Home CA client certificate (nginx fronts Nexus with mTLS) and
# the Nexus admin password from SSM.

set -euo pipefail

GO2RTC_VERSION="v1.9.14"
LIBRESPOT_VERSION="0.8.0"

NEXUS_HOST="${NEXUS_HOST:-packages.home.nakomis.com}"
NEXUS_REPO="${NEXUS_REPO:-artefacts-raw}"
CLIENT_CERT="${CLIENT_CERT:-$HOME/.config/nakomis/client-cert.pem}"
CLIENT_KEY="${CLIENT_KEY:-$HOME/.config/nakomis/client-key.pem}"
NEXUS_AWS_PROFILE="${NEXUS_AWS_PROFILE:-nakom.is-admin}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRESPOT_BIN=""
VERSION=""

while (( $# )); do
    case "$1" in
        --librespot) LIBRESPOT_BIN="$2"; shift 2 ;;
        -h|--help)   sed -n '2,40p' "$0"; exit 0 ;;
        *)           VERSION="$1"; shift ;;
    esac
done

[[ -z "$VERSION" ]] && { echo "Usage: $0 <feed-version> [--librespot PATH]" >&2; exit 1; }
for f in "$CLIENT_CERT" "$CLIENT_KEY"; do
    [[ -f "$f" ]] || { echo "Client certificate not found: $f" >&2; exit 1; }
done

echo "Fetching the Nexus admin password from SSM…"
NEXUS_PASS="$(aws ssm get-parameter --name /nexus/admin-password --with-decryption \
    --query Parameter.Value --output text --region eu-west-2 \
    --profile "$NEXUS_AWS_PROFILE")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# PUT one file, plus a .sha256 beside it so the playbook can verify what it
# downloaded rather than trusting the transfer.
publish() {
    # Separate statements on purpose: bash expands every word of a `local`
    # before assigning any of them, so referring to $dest in the same
    # statement that sets it is an unbound variable under `set -u`.
    local src="$1"
    local dest="$2"
    local url="https://${NEXUS_HOST}/repository/${NEXUS_REPO}/${dest}"
    local sum
    sum="$(shasum -a 256 "$src" | cut -d' ' -f1)"
    printf '%s  %s\n' "$sum" "$(basename "$dest")" > "$WORK/sum"

    for pair in "$src:$url" "$WORK/sum:${url}.sha256"; do
        local file="${pair%%:*}" target="${pair#*:}"
        local code
        code="$(curl -s -o /dev/null -w '%{http_code}' --cert "$CLIENT_CERT" --key "$CLIENT_KEY" \
            -u "admin:${NEXUS_PASS}" --upload-file "$file" "$target")"
        case "$code" in
            2*) echo "  published  $target" ;;
            400|403) echo "  REFUSED ($code) $target" >&2
                     echo "  ALLOW_ONCE means this version already exists. Bump it." >&2
                     exit 1 ;;
            *)  echo "  FAILED ($code) $target" >&2; exit 1 ;;
        esac
    done
    echo "             sha256 $sum"
}

echo "==> go2rtc ${GO2RTC_VERSION}"
curl -sSfL -o "$WORK/go2rtc_linux_amd64" \
    "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/go2rtc_linux_amd64"
publish "$WORK/go2rtc_linux_amd64" "third-party/go2rtc/${GO2RTC_VERSION}/go2rtc_linux_amd64"

if [[ -n "$LIBRESPOT_BIN" ]]; then
    echo "==> librespot ${LIBRESPOT_VERSION}"
    [[ -f "$LIBRESPOT_BIN" ]] || { echo "Not found: $LIBRESPOT_BIN" >&2; exit 1; }
    publish "$LIBRESPOT_BIN" "third-party/librespot/${LIBRESPOT_VERSION}/librespot_linux_amd64"
else
    echo "==> librespot skipped (no --librespot given)"
fi

echo "==> naktv-feed ${VERSION}"
TAR="$WORK/naktv-feed-${VERSION}.tar.gz"
tar -czf "$TAR" -C "$HERE" \
    --exclude='*.pyc' --exclude='__pycache__' \
    feed/bin feed/go2rtc.yaml.j2 feed/README.md
publish "$TAR" "naktv-feed/${VERSION}/naktv-feed-${VERSION}.tar.gz"

echo
echo "Done. The playbook installs these by version; nothing here is mutable."

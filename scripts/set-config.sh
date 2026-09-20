#!/usr/bin/env bash
# Populate app/src/secrets.json from SSM, following the pattern used across the
# estate (see nakom.is/set-config.sh, nakostat/web/scripts/set-config.sh).
#
# The only secret the app needs is OctoPrint's API key, which already lives at
# SSM /octoprint/api-key — the same parameter Leia's Ansible templates into
# OctoPrint's own users.yaml. Rebuild Leia from scratch and the key is
# unchanged, so this stays reproducible rather than something clicked in a UI.
#
# Run by `prebuild`, so a plain `pnpm run build` does the right thing:
#   - no secrets.json           -> created from the committed template
#   - placeholder still in it   -> filled from SSM when credentials allow
#   - real key already present  -> left alone (pass --force to refresh)
#   - no AWS credentials        -> placeholder kept, build proceeds
#
# That last case is what CI hits. The build succeeds, the .ipk carries no key,
# and the overlay reports itself unconfigured instead of failing obscurely.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$HERE/app/src/secrets.json"
TEMPLATE="$HERE/app/src/secrets.json.template"
PLACEHOLDER='<OCTOPRINT_API_KEY>'

# Its own variable, deliberately: this repo's CLAUDE.md sets AWS_PROFILE to
# nakom.is-sandbox for day-to-day work, and the key lives in prod. Inheriting
# an ambient AWS_PROFILE reads the wrong account and reports "no credentials",
# which sends you looking at SSO rather than at the account.
: "${OCTOPRINT_AWS_PROFILE:=nakom.is-admin}"
: "${OCTOPRINT_KEY_PARAM:=/octoprint/api-key}"

force=0
[[ ${1:-} == --force ]] && force=1

if [[ ! -f $TEMPLATE ]]; then
  echo "set-config: $TEMPLATE is missing" >&2
  exit 1
fi

if [[ ! -f $SECRETS ]]; then
  cp "$TEMPLATE" "$SECRETS"
  echo "set-config: created app/src/secrets.json from the template"
fi

if [[ $force -eq 0 ]] && ! grep -q "$PLACEHOLDER" "$SECRETS"; then
  echo "set-config: key already set, leaving it alone (--force to refresh)"
  exit 0
fi

# CI deliberately never reads the key. The .ipk is not published, so CI has no
# need of it, and not fetching it is a stronger guarantee than trusting that
# the artefact goes nowhere. The placeholder is enough to compile against.
if [[ -n ${CI:-} ]]; then
  echo "set-config: CI detected; keeping the placeholder deliberately"
  exit 0
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "set-config: no aws CLI; keeping the placeholder"
  exit 0
fi

key=$(AWS_PROFILE="$OCTOPRINT_AWS_PROFILE" aws ssm get-parameter \
        --name "$OCTOPRINT_KEY_PARAM" --with-decryption \
        --query Parameter.Value --output text 2>/dev/null) || key=""

if [[ -z $key || $key == "None" ]]; then
  echo "set-config: could not read $OCTOPRINT_KEY_PARAM from $OCTOPRINT_AWS_PROFILE; keeping the placeholder"
  exit 0
fi

# Written with python rather than sed so the key is never word-split or
# re-quoted, and never appears in a command line other processes can see.
OCTOPRINT_KEY="$key" python3 - "$SECRETS" <<'PY'
import json, os, sys
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)
data["octoprintApiKey"] = os.environ["OCTOPRINT_KEY"]
with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY

echo "set-config: octoprintApiKey populated from $OCTOPRINT_KEY_PARAM"

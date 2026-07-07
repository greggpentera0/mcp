#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

load_github_token() {
  [[ -f "$ENV_FILE" ]] || return 0
  [[ -z "${GITHUB_TOKEN:-}" ]] || return 0

  local line value
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    [[ "$line" != \#* ]] || continue

    case "$line" in
      GITHUB_TOKEN=*)
        value="${line#GITHUB_TOKEN=}"
        value="${value%$'\r'}"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        [[ -n "$value" ]] || return 0
        export GITHUB_TOKEN="$value"
        return 0
        ;;
    esac
  done < "$ENV_FILE"
}

load_github_token
cd "$REPO_ROOT"
exec npx release-it --config config/release-it.json "$@"

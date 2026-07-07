#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEFAULT_MODEL_ID="qwen3-coder:30b"
DEFAULT_MODEL_DISPLAY_NAME="Qwen3 Coder 30B (local)"
DEFAULT_PROVIDER_ID="ollama"
DEFAULT_PROVIDER_NAME="Ollama (local)"
DEFAULT_CONFIG_FILE="$SCRIPT_DIR/opencode.json"
OLLAMA_INSTALL_URL="https://ollama.com/install.sh"
OLLAMA_API_BASE_URL="http://localhost:11434"
OPENCODE_OLLAMA_BASE_URL="$OLLAMA_API_BASE_URL/v1"
OLLAMA_START_TIMEOUT_SECONDS="90"
OLLAMA_START_POLL_SECONDS="2"
OLLAMA_LOG_FILE="${TMPDIR:-/tmp}/ollama-local-ai-installation.log"

MODEL_ID="${LOCAL_AI_MODEL_ID:-$DEFAULT_MODEL_ID}"
MODEL_DISPLAY_NAME="${LOCAL_AI_MODEL_DISPLAY_NAME:-}"
PROVIDER_ID="${LOCAL_AI_PROVIDER_ID:-$DEFAULT_PROVIDER_ID}"
PROVIDER_NAME="${LOCAL_AI_PROVIDER_NAME:-$DEFAULT_PROVIDER_NAME}"
CONFIG_FILE="${LOCAL_AI_OPENCODE_CONFIG:-$DEFAULT_CONFIG_FILE}"
SKIP_OLLAMA_INSTALL="false"
SKIP_MODEL_PULL="false"

print_step() {
  printf '[local-ai] %s\n' "$*"
}

print_warn() {
  printf '[local-ai] warning: %s\n' "$*" >&2
}

print_error() {
  printf '[local-ai] error: %s\n' "$*" >&2
}

fail() {
  print_error "$*"
  exit 1
}

on_error() {
  print_error "command failed at line ${1}: ${2}"
}

trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

usage() {
  cat <<'USAGE'
Usage: ./local-ai-installation.sh [options]

Install Ollama, pull a local coding model, and configure OpenCode to use it.

Default behavior:
  - Installs Ollama when the ollama command is unavailable.
  - Starts the local Ollama API on http://localhost:11434 when needed.
  - Pulls qwen3-coder:30b for local coding work.
  - Writes opencode.json next to this script.
  - Preserves existing opencode.json settings and updates only the Ollama
    provider plus the default model fields.

Options:
  --model MODEL              Ollama model ID to pull and configure.
                             Default: qwen3-coder:30b.
  --model-name NAME          Display name in OpenCode.
                             Default: Qwen3 Coder 30B (local).
  --config PATH              opencode.json path to write.
                             Default: ./opencode.json next to this script.
  --global-config            Write ~/.config/opencode/opencode.json.
  --skip-ollama-install      Fail if ollama is missing instead of installing it.
  --skip-model-pull          Configure OpenCode without pulling the model.
  -h, --help                 Show this help.

Environment overrides:
  LOCAL_AI_MODEL_ID
  LOCAL_AI_MODEL_DISPLAY_NAME
  LOCAL_AI_PROVIDER_ID
  LOCAL_AI_PROVIDER_NAME
  LOCAL_AI_OPENCODE_CONFIG
USAGE
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_arg() {
  local option="$1"
  local value="${2-}"

  if [[ -z "$value" || "$value" == --* ]]; then
    fail "${option} requires a value"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)
        require_arg "$1" "${2-}"
        MODEL_ID="$2"
        shift 2
        ;;
      --model-name)
        require_arg "$1" "${2-}"
        MODEL_DISPLAY_NAME="$2"
        shift 2
        ;;
      --config)
        require_arg "$1" "${2-}"
        CONFIG_FILE="$2"
        shift 2
        ;;
      --global-config)
        CONFIG_FILE="$HOME/.config/opencode/opencode.json"
        shift
        ;;
      --skip-ollama-install)
        SKIP_OLLAMA_INSTALL="true"
        shift
        ;;
      --skip-model-pull)
        SKIP_MODEL_PULL="true"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        fail "unknown option: $1"
        ;;
    esac
  done
}

set_default_display_name() {
  if [[ -n "$MODEL_DISPLAY_NAME" ]]; then
    return 0
  fi

  if [[ "$MODEL_ID" == "$DEFAULT_MODEL_ID" ]]; then
    MODEL_DISPLAY_NAME="$DEFAULT_MODEL_DISPLAY_NAME"
  else
    MODEL_DISPLAY_NAME="${MODEL_ID} (local)"
  fi
}

download_url_to_file() {
  local url="$1"
  local output="$2"

  if command_exists curl; then
    curl -fsSL "$url" -o "$output"
    return $?
  fi

  if command_exists wget; then
    wget -q -O "$output" "$url"
    return $?
  fi

  print_error "curl or wget is required to download $url."
  return 1
}

install_ollama() {
  if command_exists ollama; then
    print_step "Ollama is already installed: $(ollama --version 2>/dev/null || printf 'version unavailable')"
    return 0
  fi

  if [[ "$SKIP_OLLAMA_INSTALL" == "true" ]]; then
    fail "ollama is not installed and --skip-ollama-install was provided"
  fi

  local os_name
  os_name="$(uname -s)"

  case "$os_name" in
    Darwin | Linux)
      ;;
    *)
      fail "automatic Ollama installation is supported on macOS and Linux; install Ollama first on $os_name"
      ;;
  esac

  if command_exists brew; then
    print_step "Installing Ollama with Homebrew."
    brew install ollama
    return 0
  fi

  local installer
  installer="$(mktemp)"
  print_step "Downloading the official Ollama installer."
  download_url_to_file "$OLLAMA_INSTALL_URL" "$installer"
  sh "$installer"
  rm -f "$installer"
}

ollama_api_available() {
  if command_exists curl; then
    curl -fsS --max-time 2 "$OLLAMA_API_BASE_URL/api/tags" >/dev/null 2>&1
    return $?
  fi

  ollama list >/dev/null 2>&1
}

start_ollama() {
  if ollama_api_available; then
    print_step "Ollama API is already running at $OLLAMA_API_BASE_URL."
    return 0
  fi

  print_step "Starting Ollama API."

  if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "/Applications/Ollama.app" ]]; then
    open -ga Ollama
  elif command_exists brew && brew services list 2>/dev/null | grep -q '^ollama[[:space:]]'; then
    brew services start ollama
  else
    nohup ollama serve >"$OLLAMA_LOG_FILE" 2>&1 &
  fi

  local waited_seconds="0"
  while [[ "$waited_seconds" -lt "$OLLAMA_START_TIMEOUT_SECONDS" ]]; do
    if ollama_api_available; then
      print_step "Ollama API is ready."
      return 0
    fi

    sleep "$OLLAMA_START_POLL_SECONDS"
    waited_seconds="$((waited_seconds + OLLAMA_START_POLL_SECONDS))"
  done

  fail "Ollama API did not become ready within ${OLLAMA_START_TIMEOUT_SECONDS}s; check $OLLAMA_LOG_FILE"
}

model_is_installed() {
  local model_id="$1"

  ollama list | awk 'NR > 1 { print $1 }' | grep -Fxq "$model_id"
}

pull_model() {
  if [[ "$SKIP_MODEL_PULL" == "true" ]]; then
    print_step "Skipping model pull for $MODEL_ID."
    return 0
  fi

  if model_is_installed "$MODEL_ID"; then
    print_step "Model is already installed: $MODEL_ID."
    return 0
  fi

  print_step "Pulling Ollama model: $MODEL_ID."
  ollama pull "$MODEL_ID"
}

write_opencode_config_with_node() {
  CONFIG_FILE="$CONFIG_FILE" \
  MODEL_ID="$MODEL_ID" \
  MODEL_DISPLAY_NAME="$MODEL_DISPLAY_NAME" \
  PROVIDER_ID="$PROVIDER_ID" \
  PROVIDER_NAME="$PROVIDER_NAME" \
  OPENCODE_OLLAMA_BASE_URL="$OPENCODE_OLLAMA_BASE_URL" \
    node <<'NODE'
const fs = require("fs");
const path = require("path");

const configFile = process.env.CONFIG_FILE;
const modelId = process.env.MODEL_ID;
const modelDisplayName = process.env.MODEL_DISPLAY_NAME;
const providerId = process.env.PROVIDER_ID;
const providerName = process.env.PROVIDER_NAME;
const baseURL = process.env.OPENCODE_OLLAMA_BASE_URL;

function fail(message) {
  console.error(`[local-ai] error: ${message}`);
  process.exit(1);
}

function objectOrEmpty(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return {};
}

let config = {};

if (fs.existsSync(configFile)) {
  const existingConfig = fs.readFileSync(configFile, "utf8").trim();

  if (existingConfig.length > 0) {
    try {
      config = JSON.parse(existingConfig);
    } catch (error) {
      fail(`${configFile} exists but is not valid JSON: ${error.message}`);
    }
  }
}

config = objectOrEmpty(config);
config.$schema = config.$schema || "https://opencode.ai/config.json";
config.provider = objectOrEmpty(config.provider);

const provider = objectOrEmpty(config.provider[providerId]);
provider.npm = "@ai-sdk/openai-compatible";
provider.name = providerName;
provider.options = objectOrEmpty(provider.options);
provider.options.baseURL = baseURL;
provider.models = objectOrEmpty(provider.models);
provider.models[modelId] = {
  ...objectOrEmpty(provider.models[modelId]),
  name: modelDisplayName,
};

config.provider[providerId] = provider;
config.model = `${providerId}/${modelId}`;
config.small_model = `${providerId}/${modelId}`;

fs.mkdirSync(path.dirname(configFile), { recursive: true });

const tempFile = `${configFile}.tmp-${process.pid}`;
fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o644,
});
fs.renameSync(tempFile, configFile);
NODE
}

write_opencode_config_with_python() {
  CONFIG_FILE="$CONFIG_FILE" \
  MODEL_ID="$MODEL_ID" \
  MODEL_DISPLAY_NAME="$MODEL_DISPLAY_NAME" \
  PROVIDER_ID="$PROVIDER_ID" \
  PROVIDER_NAME="$PROVIDER_NAME" \
  OPENCODE_OLLAMA_BASE_URL="$OPENCODE_OLLAMA_BASE_URL" \
    python3 <<'PYTHON'
import json
import os
import sys


def fail(message):
    print(f"[local-ai] error: {message}", file=sys.stderr)
    sys.exit(1)


def object_or_empty(value):
    if isinstance(value, dict):
        return value

    return {}


config_file = os.environ["CONFIG_FILE"]
model_id = os.environ["MODEL_ID"]
model_display_name = os.environ["MODEL_DISPLAY_NAME"]
provider_id = os.environ["PROVIDER_ID"]
provider_name = os.environ["PROVIDER_NAME"]
base_url = os.environ["OPENCODE_OLLAMA_BASE_URL"]

config = {}

if os.path.exists(config_file):
    with open(config_file, "r", encoding="utf-8") as existing_file:
        existing_config = existing_file.read().strip()

    if existing_config:
        try:
            config = json.loads(existing_config)
        except json.JSONDecodeError as error:
            fail(f"{config_file} exists but is not valid JSON: {error}")

config = object_or_empty(config)
config["$schema"] = config.get("$schema") or "https://opencode.ai/config.json"
config["provider"] = object_or_empty(config.get("provider"))

provider = object_or_empty(config["provider"].get(provider_id))
provider["npm"] = "@ai-sdk/openai-compatible"
provider["name"] = provider_name
provider["options"] = object_or_empty(provider.get("options"))
provider["options"]["baseURL"] = base_url
provider["models"] = object_or_empty(provider.get("models"))

model = object_or_empty(provider["models"].get(model_id))
model["name"] = model_display_name
provider["models"][model_id] = model

config["provider"][provider_id] = provider
config["model"] = f"{provider_id}/{model_id}"
config["small_model"] = f"{provider_id}/{model_id}"

config_dir = os.path.dirname(config_file) or "."
os.makedirs(config_dir, exist_ok=True)

temp_file = f"{config_file}.tmp-{os.getpid()}"
flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
with os.fdopen(os.open(temp_file, flags, 0o644), "w", encoding="utf-8") as output_file:
    json.dump(config, output_file, indent=2)
    output_file.write("\n")

os.replace(temp_file, config_file)
PYTHON
}

configure_opencode() {
  if ! command_exists opencode; then
    print_warn "opencode is not in PATH. Continuing because this script only writes OpenCode configuration."
  fi

  print_step "Writing OpenCode config: $CONFIG_FILE."

  if command_exists node; then
    write_opencode_config_with_node
  elif command_exists python3; then
    write_opencode_config_with_python
  else
    fail "node or python3 is required to merge opencode.json without overwriting existing settings"
  fi
}

print_summary() {
  cat <<SUMMARY
[local-ai] complete
[local-ai] model: ${MODEL_ID}
[local-ai] OpenCode model id: ${PROVIDER_ID}/${MODEL_ID}
[local-ai] config: ${CONFIG_FILE}
[local-ai] next command: opencode
SUMMARY
}

main() {
  parse_args "$@"
  set_default_display_name
  install_ollama
  start_ollama
  pull_model
  configure_opencode
  print_summary
}

main "$@"

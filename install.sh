#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
LAUNCH_SCRIPT="$REPO_ROOT/launch.sh"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE_FILE="$REPO_ROOT/.env.example"

DEFAULT_HOST="0.0.0.0"
DEFAULT_SERVER_PORT="3221"
DEFAULT_VITE_PORT="5173"
SERVICE_NAME="cloudcli-mcp.service"
HEALTH_CHECK_ATTEMPTS="90"
HEALTH_CHECK_INTERVAL_SECONDS="2"
CURL_TIMEOUT_SECONDS="2"
PROCESS_STOP_ATTEMPTS="25"
PROCESS_STOP_INTERVAL_SECONDS="0.2"
LOG_DIR=""
VALIDATION_PID=""
ALLOW_NON_UBUNTU="false"
AUTH_MODE="env"
LAUNCH_SETUP_ARGS=()
HOST_ARG_SET="false"
SERVER_PORT_ARG_SET="false"
VITE_PORT_ARG_SET="false"

print_step() {
  printf '[mcp-playground-install] %s\n' "$*"
}

print_warn() {
  printf '[mcp-playground-install] warning: %s\n' "$*" >&2
}

print_error() {
  printf '[mcp-playground-install] error: %s\n' "$*" >&2
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
Usage: ./install.sh [options]

Validate MCP Playground from this checkout, then install it as an Ubuntu
systemd user service after interactive confirmation.

Default behavior:
  - Requires an interactive terminal.
  - Requires Ubuntu unless --allow-non-ubuntu is set.
  - Stops any existing MCP Playground user service before validation.
  - Starts ./launch.sh --dev in a background validation process.
  - Waits for backend health and frontend HTTP checks.
  - Prints URLs for the user to test.
  - Uses .env for host, ports, and auth unless explicitly overridden.
  - Installs ./launch.sh --service only after the user confirms access.

Options:
  --host HOST            Bind address for validation and service.
                         Defaults to 0.0.0.0 for Ubuntu server access.
  --server-port PORT     Backend port for validation and service.
  --backend-port PORT    Alias for --server-port.
  --vite-port PORT       Frontend dev validation port.
  --frontend-port PORT   Alias for --vite-port.
  --auth                 Enable login/setup, overriding .env auth flags.
  --local-auth-disabled  Bind to 127.0.0.1 and disable username/password auth.
  --no-install           Pass through to launch.sh.
  --no-agent-cli-install Pass through to launch.sh.
  --upgrade-agent-clis   Pass through to launch.sh.
  --strict-agent-clis    Pass through to launch.sh.
  --reinstall            Pass through to launch.sh.
  --rebuild-native       Pass through to launch.sh.
  --allow-non-ubuntu     Allow execution on non-Ubuntu Linux systems.
  -h, --help             Show this help.

Examples:
  ./install.sh
  ./install.sh --host 0.0.0.0 --auth
  ./install.sh --local-auth-disabled
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

env_file_value() {
  local key="$1"
  local file="$2"

  [[ -f "$file" ]] || return 1

  awk -F= -v key="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      candidate = $1
      sub(/^[[:space:]]+/, "", candidate)
      sub(/[[:space:]]+$/, "", candidate)
      if (candidate == key) {
        value = substr($0, index($0, "=") + 1)
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        print value
        exit
      }
    }
  ' "$file"
}

env_value() {
  local key="$1"
  local fallback="$2"
  local current="${!key-}"
  local from_file=""

  if [[ -n "$current" ]]; then
    printf '%s\n' "$current"
    return 0
  fi

  from_file="$(env_file_value "$key" "$ENV_FILE" || true)"
  if [[ -n "$from_file" ]]; then
    printf '%s\n' "$from_file"
    return 0
  fi

  from_file="$(env_file_value "$key" "$ENV_EXAMPLE_FILE" || true)"
  if [[ -n "$from_file" ]]; then
    printf '%s\n' "$from_file"
    return 0
  fi

  printf '%s\n' "$fallback"
}

HOST_VALUE="$(env_value HOST "$DEFAULT_HOST")"
SERVER_PORT_VALUE="$(env_value SERVER_PORT "$DEFAULT_SERVER_PORT")"
VITE_PORT_VALUE="$(env_value VITE_PORT "$DEFAULT_VITE_PORT")"

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --host)
        require_arg "$1" "${2-}"
        HOST_VALUE="$2"
        HOST_ARG_SET="true"
        shift 2
        ;;
      --server-port|--backend-port)
        require_arg "$1" "${2-}"
        SERVER_PORT_VALUE="$2"
        SERVER_PORT_ARG_SET="true"
        shift 2
        ;;
      --vite-port|--frontend-port)
        require_arg "$1" "${2-}"
        VITE_PORT_VALUE="$2"
        VITE_PORT_ARG_SET="true"
        shift 2
        ;;
      --auth)
        AUTH_MODE="auth"
        shift
        ;;
      --local-auth-disabled)
        AUTH_MODE="local-auth-disabled"
        HOST_VALUE="127.0.0.1"
        HOST_ARG_SET="true"
        shift
        ;;
      --no-install|--no-agent-cli-install|--upgrade-agent-clis|--strict-agent-clis|--reinstall|--rebuild-native)
        LAUNCH_SETUP_ARGS+=("$1")
        shift
        ;;
      --allow-non-ubuntu)
        ALLOW_NON_UBUNTU="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "unknown option: $1"
        ;;
    esac
  done
}

check_interactive_terminal() {
  [[ -t 0 ]] || fail "interactive terminal input is required for access confirmation."
}

check_ubuntu() {
  local os_id=""

  [[ "$(uname -s)" == "Linux" ]] || fail "install.sh is intended for Ubuntu Linux."
  [[ -r /etc/os-release ]] || fail "/etc/os-release was not found."

  # shellcheck source=/dev/null
  . /etc/os-release
  os_id="${ID:-}"

  if [[ "$os_id" == "ubuntu" || "$ALLOW_NON_UBUNTU" == "true" ]]; then
    return 0
  fi

  fail "Ubuntu is required. Use --allow-non-ubuntu to run on another Linux distribution."
}

check_prerequisites() {
  [[ -x "$LAUNCH_SCRIPT" ]] || fail "launch.sh is missing or not executable at $LAUNCH_SCRIPT."
  command_exists curl || fail "curl is required for health checks."
  command_exists setsid || fail "setsid is required to manage the validation process group."
  command_exists systemctl || fail "systemctl is required for the Ubuntu service install."
}

url_host() {
  local host="$1"

  case "$host" in
    ""|"0.0.0.0"|"::")
      printf '127.0.0.1\n'
      ;;
    "::1")
      printf '[::1]\n'
      ;;
    *)
      printf '%s\n' "$host"
      ;;
  esac
}

detected_network_host() {
  local host="$1"
  local detected=""

  case "$host" in
    "0.0.0.0"|"::"|"")
      detected="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
      printf '%s\n' "${detected:-127.0.0.1}"
      ;;
    *)
      printf '%s\n' "$host"
      ;;
  esac
}

validation_frontend_url() {
  printf 'http://%s:%s\n' "$(url_host "$HOST_VALUE")" "$VITE_PORT_VALUE"
}

validation_health_url() {
  printf 'http://%s:%s/health\n' "$(url_host "$HOST_VALUE")" "$SERVER_PORT_VALUE"
}

user_frontend_url() {
  printf 'http://%s:%s\n' "$(detected_network_host "$HOST_VALUE")" "$VITE_PORT_VALUE"
}

service_url() {
  printf 'http://%s:%s\n' "$(detected_network_host "$HOST_VALUE")" "$SERVER_PORT_VALUE"
}

build_launch_args() {
  COMMON_LAUNCH_ARGS=()

  if [[ "$SERVER_PORT_ARG_SET" == "true" ]]; then
    COMMON_LAUNCH_ARGS+=(--server-port "$SERVER_PORT_VALUE")
  fi

  if [[ "$VITE_PORT_ARG_SET" == "true" ]]; then
    COMMON_LAUNCH_ARGS+=(--vite-port "$VITE_PORT_VALUE")
  fi

  if [[ "$HOST_ARG_SET" == "true" ]]; then
    COMMON_LAUNCH_ARGS+=(--host "$HOST_VALUE")
  fi

  if [[ "$AUTH_MODE" == "local-auth-disabled" ]]; then
    COMMON_LAUNCH_ARGS+=(--local-auth-disabled)
  elif [[ "$AUTH_MODE" == "auth" ]]; then
    COMMON_LAUNCH_ARGS+=(--auth)
  fi

  COMMON_LAUNCH_ARGS+=("${LAUNCH_SETUP_ARGS[@]}")
}

validation_process_running() {
  [[ -n "$VALIDATION_PID" ]] || return 1
  kill -0 "-$VALIDATION_PID" 2>/dev/null
}

wait_for_validation_exit() {
  local attempt="1"

  while [[ "$attempt" -le "$PROCESS_STOP_ATTEMPTS" ]]; do
    if ! validation_process_running; then
      return 0
    fi

    sleep "$PROCESS_STOP_INTERVAL_SECONDS"
    attempt="$((attempt + 1))"
  done

  return 1
}

stop_validation_run() {
  if ! validation_process_running; then
    return 0
  fi

  print_step "Stopping validation run"
  kill -TERM "-$VALIDATION_PID" 2>/dev/null || true
  if wait_for_validation_exit; then
    wait "$VALIDATION_PID" 2>/dev/null || true
    return 0
  fi

  print_warn "validation run did not stop after SIGTERM; sending SIGKILL."
  kill -KILL "-$VALIDATION_PID" 2>/dev/null || true
  wait_for_validation_exit || fail "validation process group is still running after SIGKILL."
  wait "$VALIDATION_PID" 2>/dev/null || true
}

cleanup() {
  stop_validation_run
  if [[ -n "$LOG_DIR" && -d "$LOG_DIR" ]]; then
    rm -rf "$LOG_DIR"
  fi
}

trap cleanup EXIT

stop_existing_service() {
  if systemctl --user status "$SERVICE_NAME" >/dev/null 2>&1; then
    print_step "Stopping existing user service: $SERVICE_NAME"
    systemctl --user stop "$SERVICE_NAME"
  fi

  systemctl --user reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
}

start_validation_run() {
  LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mcp-playground-install.XXXXXX")"
  local log_file="$LOG_DIR/validation.log"

  print_step "Starting validation run"
  print_step "Validation log: $log_file"

  setsid "$LAUNCH_SCRIPT" --dev "${COMMON_LAUNCH_ARGS[@]}" > "$log_file" 2>&1 &
  VALIDATION_PID="$!"
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempt="1"

  while [[ "$attempt" -le "$HEALTH_CHECK_ATTEMPTS" ]]; do
    if curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1; then
      return 0
    fi

    if ! validation_process_running; then
      print_error "validation run exited before ${label} became ready."
      return 1
    fi

    sleep "$HEALTH_CHECK_INTERVAL_SECONDS"
    attempt="$((attempt + 1))"
  done

  print_error "${label} did not respond at $url."
  return 1
}

print_validation_log_tail() {
  local log_file="$LOG_DIR/validation.log"

  [[ -f "$log_file" ]] || return 0
  print_error "last validation log lines:"
  tail -n 80 "$log_file" >&2 || true
}

wait_for_validation_ready() {
  local frontend_url
  local health_url

  frontend_url="$(validation_frontend_url)"
  health_url="$(validation_health_url)"

  if ! wait_for_url "backend health" "$health_url"; then
    print_validation_log_tail
    fail "backend validation failed."
  fi

  if ! wait_for_url "frontend" "$frontend_url"; then
    print_validation_log_tail
    fail "frontend validation failed."
  fi

  print_step "Validation checks passed"
}

confirm_access() {
  local answer

  printf '\n'
  print_step "Open the validation URL and verify the app is usable."
  printf '  Validation URL: %s\n' "$(user_frontend_url)"
  printf '  Health URL:     %s\n' "$(validation_health_url)"
  printf '\n'
  printf 'Type yes after access is confirmed to install the background service: '
  read -r answer

  case "$answer" in
    yes|YES|y|Y)
      return 0
      ;;
    *)
      fail "service installation cancelled before confirmation."
      ;;
  esac
}

install_service() {
  print_step "Installing background service"
  stop_existing_service
  "$LAUNCH_SCRIPT" --service "${COMMON_LAUNCH_ARGS[@]}"
}

wait_for_service_health() {
  local url
  local attempt="1"

  url="$(validation_health_url)"
  while [[ "$attempt" -le "$HEALTH_CHECK_ATTEMPTS" ]]; do
    if curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1; then
      print_step "Service health check passed: $url"
      return 0
    fi

    sleep "$HEALTH_CHECK_INTERVAL_SECONDS"
    attempt="$((attempt + 1))"
  done

  fail "service did not pass health check at $url."
}

print_service_summary() {
  printf '\n'
  print_step "MCP Playground is installed as a background user service."
  printf '  Service URL: %s\n' "$(service_url)"
  printf '  Status:      systemctl --user status %s\n' "$SERVICE_NAME"
  printf '  Logs:        journalctl --user -u %s -f\n' "$SERVICE_NAME"
}

main() {
  parse_args "$@"
  build_launch_args
  check_interactive_terminal
  check_ubuntu
  check_prerequisites
  stop_existing_service
  start_validation_run
  wait_for_validation_ready
  confirm_access
  stop_validation_run
  install_service
  wait_for_service_health
  print_service_summary
}

main "$@"

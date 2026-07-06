#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

DEFAULT_NODE_VERSION="22"
NODE_VERSION_FILE="$REPO_ROOT/.nvmrc"
DEFAULT_HOST="127.0.0.1"
DEFAULT_SERVER_PORT="3221"
DEFAULT_VITE_PORT="5173"
HEALTH_CHECK_ATTEMPTS="30"
HEALTH_CHECK_INTERVAL_SECONDS="1"
CURL_TIMEOUT_SECONDS="2"
OPEN_DELAY_SECONDS="3"
SYSTEMD_SERVICE_NAME="cloudcli-mcp.service"
LAUNCHD_LABEL="com.mcp-playground.local"
NATIVE_PACKAGES=(better-sqlite3 node-pty bcrypt sharp)

MODE="dev"
RUN_NPM_INSTALL="true"
FORCE_REINSTALL="false"
REBUILD_NATIVE="false"
OPEN_BROWSER="false"

print_step() {
  printf '[mcp-playground] %s\n' "$*"
}

print_warn() {
  printf '[mcp-playground] warning: %s\n' "$*" >&2
}

print_error() {
  printf '[mcp-playground] error: %s\n' "$*" >&2
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
Usage: ./launch-mcp-playground.sh [options]

Launch MCP Playground from this source checkout on macOS or Linux.

Default behavior:
  - Detects macOS or Linux.
  - Uses Node.js 22 from nvm when available.
  - On macOS without nvm, installs or uses Homebrew node@22.
  - Copies .env.example to .env when .env does not exist.
  - Runs npm install when dependencies are missing or stale.
  - Starts the development app with npm run dev.

Options:
  --service              Build and install a persistent user service.
                         Uses systemd --user on Linux and launchd on macOS.
  --dev                  Start the foreground development server. This is the default.
  --no-install           Skip npm install.
  --reinstall            Remove node_modules before npm install.
  --rebuild-native       Rebuild native packages for the active Node.js 22 runtime.
  --host HOST            Override HOST for this launch or service install.
  --server-port PORT     Override SERVER_PORT for this launch or service install.
  --backend-port PORT    Alias for --server-port.
  --vite-port PORT       Override VITE_PORT for this launch or service install.
  --frontend-port PORT   Alias for --vite-port.
  --auth                 Enable login/setup for this launch or service install.
  --local-auth-disabled  Bind to 127.0.0.1 and disable username/password auth.
  --open                 Open the frontend URL in the default browser.
  -h, --help             Show this help.

Examples:
  ./launch-mcp-playground.sh
  ./launch-mcp-playground.sh --rebuild-native
  ./launch-mcp-playground.sh --service
  ./launch-mcp-playground.sh --host 0.0.0.0 --auth --service
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

read_required_node_version() {
  local version="$DEFAULT_NODE_VERSION"

  if [[ -f "$NODE_VERSION_FILE" ]]; then
    version="$(sed -n '1s/[[:space:]]//gp' "$NODE_VERSION_FILE")"
    version="${version:-$DEFAULT_NODE_VERSION}"
  fi

  printf '%s\n' "$version"
}

node_major_from_version() {
  local version="$1"

  version="${version#v}"
  printf '%s\n' "${version%%.*}"
}

node_major() {
  command_exists node || return 1
  node -p "process.versions.node.split('.')[0]" 2>/dev/null
}

load_nvm() {
  if command_exists nvm; then
    return 0
  fi

  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  local nvm_script="$nvm_root/nvm.sh"

  if [[ ! -s "$nvm_script" ]]; then
    return 1
  fi

  set +u
  # shellcheck source=/dev/null
  . "$nvm_script"
  set -u
}

use_nvm_node() {
  local required_version="$1"

  if ! load_nvm; then
    return 1
  fi

  print_step "Using Node ${required_version} through nvm"
  nvm install "$required_version"
  nvm use "$required_version"
}

use_homebrew_node() {
  local required_major="$1"
  local formula="node@${required_major}"
  local prefix

  [[ "$(uname -s)" == "Darwin" ]] || return 1
  command_exists brew || return 1

  if ! prefix="$(brew --prefix "$formula" 2>/dev/null)"; then
    print_step "Installing ${formula} with Homebrew"
    brew install "$formula"
    prefix="$(brew --prefix "$formula")"
  fi

  export PATH="$prefix/bin:$PATH"
  hash -r
}

select_node_runtime() {
  local required_version="$1"
  local required_major="$2"
  local current_major=""

  if use_nvm_node "$required_version"; then
    return 0
  fi

  current_major="$(node_major || true)"
  if [[ "$current_major" == "$required_major" ]]; then
    return 0
  fi

  if use_homebrew_node "$required_major"; then
    return 0
  fi

  fail "Node.js ${required_major} is required. Install nvm or put Node ${required_major} on PATH."
}

require_node_runtime() {
  local required_version
  local required_major
  local current_major

  required_version="$(read_required_node_version)"
  required_major="$(node_major_from_version "$required_version")"

  select_node_runtime "$required_version" "$required_major"
  current_major="$(node_major || true)"

  if [[ "$current_major" != "$required_major" ]]; then
    fail "Node.js ${required_major} is required, but $(node -v 2>/dev/null || echo node) is active."
  fi

  command_exists npm || fail "npm is required with Node.js ${required_major}."
  print_step "Using $(node -v) at $(command -v node)"
}

check_supported_os() {
  case "$(uname -s)" in
    Darwin|Linux)
      return 0
      ;;
    *)
      fail "macOS and Linux are supported by this launcher."
      ;;
  esac
}

check_repo_root() {
  cd "$REPO_ROOT"

  [[ -f "$REPO_ROOT/package.json" ]] || fail "package.json was not found at $REPO_ROOT."
  [[ -f "$REPO_ROOT/README.md" ]] || fail "README.md was not found at $REPO_ROOT."
}

warn_for_missing_build_tools() {
  local os_name
  os_name="$(uname -s)"

  if [[ "$os_name" == "Linux" ]]; then
    local missing_tools=()

    command_exists make || missing_tools+=(make)
    command_exists g++ || missing_tools+=(g++)
    command_exists python3 || missing_tools+=(python3)

    if [[ "${#missing_tools[@]}" -gt 0 ]]; then
      print_warn "npm install may need build tools: ${missing_tools[*]}"
    fi
  fi

  if [[ "$os_name" == "Darwin" ]] && command_exists xcode-select; then
    if ! xcode-select -p >/dev/null 2>&1; then
      print_warn "npm install may need Xcode Command Line Tools."
    fi
  fi
}

ensure_env_file() {
  if [[ -f "$REPO_ROOT/.env" ]]; then
    print_step "Using existing .env"
    return 0
  fi

  [[ -f "$REPO_ROOT/.env.example" ]] || fail ".env.example was not found."
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  print_step "Created .env from .env.example"
}

dependencies_need_install() {
  [[ ! -d "$REPO_ROOT/node_modules" ]] && return 0
  [[ ! -f "$REPO_ROOT/node_modules/.package-lock.json" ]] && return 0
  [[ "$REPO_ROOT/package.json" -nt "$REPO_ROOT/node_modules/.package-lock.json" ]] && return 0
  [[ "$REPO_ROOT/package-lock.json" -nt "$REPO_ROOT/node_modules/.package-lock.json" ]] && return 0
  return 1
}

install_dependencies() {
  if [[ "$FORCE_REINSTALL" == "true" ]]; then
    print_step "Removing node_modules before reinstall"
    rm -rf "$REPO_ROOT/node_modules"
  fi

  if [[ "$RUN_NPM_INSTALL" != "true" ]]; then
    print_step "Skipping npm install"
  elif dependencies_need_install; then
    warn_for_missing_build_tools
    print_step "Installing npm dependencies"
    npm install
  else
    print_step "npm dependencies are already installed"
  fi

  if [[ "$REBUILD_NATIVE" == "true" ]]; then
    print_step "Rebuilding native packages for $(node -v)"
    npm rebuild "${NATIVE_PACKAGES[@]}"
  fi
}

env_file_value() {
  local key="$1"

  [[ -f "$REPO_ROOT/.env" ]] || return 1

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
  ' "$REPO_ROOT/.env"
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

  from_file="$(env_file_value "$key" || true)"
  if [[ -n "$from_file" ]]; then
    printf '%s\n' "$from_file"
    return 0
  fi

  printf '%s\n' "$fallback"
}

env_optional_value() {
  local key="$1"
  local current="${!key-}"

  if [[ -n "$current" ]]; then
    printf '%s\n' "$current"
    return 0
  fi

  env_file_value "$key" || true
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

frontend_url() {
  local host
  local vite_port

  host="$(url_host "$(env_value HOST "$DEFAULT_HOST")")"
  vite_port="$(env_value VITE_PORT "$DEFAULT_VITE_PORT")"
  printf 'http://%s:%s\n' "$host" "$vite_port"
}

backend_health_url() {
  local host
  local server_port

  host="$(url_host "$(env_value HOST "$DEFAULT_HOST")")"
  server_port="$(env_value SERVER_PORT "$DEFAULT_SERVER_PORT")"
  printf 'http://%s:%s/health\n' "$host" "$server_port"
}

wait_for_url() {
  local url="$1"
  local attempt="1"

  if ! command_exists curl; then
    sleep "$OPEN_DELAY_SECONDS"
    return 0
  fi

  while [[ "$attempt" -le "$HEALTH_CHECK_ATTEMPTS" ]]; do
    if curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1; then
      return 0
    fi

    sleep "$HEALTH_CHECK_INTERVAL_SECONDS"
    attempt="$((attempt + 1))"
  done

  return 1
}

open_url() {
  local url="$1"

  case "$(uname -s)" in
    Darwin)
      open "$url" >/dev/null 2>&1 || print_warn "could not open $url"
      ;;
    Linux)
      if command_exists xdg-open; then
        xdg-open "$url" >/dev/null 2>&1 || print_warn "could not open $url"
      else
        print_warn "xdg-open is not installed; open $url in a browser."
      fi
      ;;
  esac
}

open_url_when_ready() {
  local url="$1"

  if wait_for_url "$url"; then
    open_url "$url"
  else
    print_warn "frontend did not respond yet; open $url after startup finishes."
  fi
}

start_dev_server() {
  local ui_url
  local health_url

  ui_url="$(frontend_url)"
  health_url="$(backend_health_url)"

  print_step "Starting development server"
  print_step "Frontend: ${ui_url}"
  print_step "Backend health: ${health_url}"

  if [[ "$OPEN_BROWSER" == "true" ]]; then
    open_url_when_ready "$ui_url" &
  fi

  exec npm run dev
}

systemd_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

systemd_quote() {
  printf '"%s"' "$(systemd_escape "$1")"
}

write_systemd_env_line() {
  local key="$1"
  local value="$2"

  printf 'Environment="%s=%s"\n' "$key" "$(systemd_escape "$value")"
}

xml_escape() {
  printf '%s' "$1" |
    sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

write_plist_string_entry() {
  local indent="$1"
  local key="$2"
  local value="$3"

  printf '%s<key>%s</key>\n' "$indent" "$(xml_escape "$key")"
  printf '%s<string>%s</string>\n' "$indent" "$(xml_escape "$value")"
}

service_path_value() {
  local node_bin="$1"
  local node_dir

  node_dir="$(dirname "$node_bin")"
  printf '%s:%s\n' "$node_dir" "$PATH"
}

build_production_server() {
  print_step "Building production frontend and server"
  npm run build
}

install_linux_service() {
  command_exists systemctl || fail "systemctl is required for Linux service mode."

  local node_bin
  local node_path
  local service_dir
  local service_file
  local server_port
  local vite_port
  local host
  local disable_auth
  local vite_disable_auth
  local antigravity_path
  local opencode_path
  local opencode_config

  node_bin="$(command -v node)"
  node_path="$(service_path_value "$node_bin")"
  service_dir="$HOME/.config/systemd/user"
  service_file="$service_dir/$SYSTEMD_SERVICE_NAME"
  server_port="$(env_value SERVER_PORT "$DEFAULT_SERVER_PORT")"
  vite_port="$(env_value VITE_PORT "$DEFAULT_VITE_PORT")"
  host="$(env_value HOST "$DEFAULT_HOST")"
  disable_auth="$(env_value DISABLE_AUTH "true")"
  vite_disable_auth="$(env_value VITE_DISABLE_AUTH "true")"
  antigravity_path="$(env_value ANTIGRAVITY_PATH "agy")"
  opencode_path="$(env_value OPENCODE_PATH "opencode")"
  opencode_config="$(env_optional_value OPENCODE_CONFIG)"

  mkdir -p "$service_dir"

  {
    printf '[Unit]\n'
    printf 'Description=MCP Playground\n'
    printf 'After=network-online.target\n\n'
    printf '[Service]\n'
    printf 'Type=simple\n'
    printf 'WorkingDirectory=%s\n' "$(systemd_quote "$REPO_ROOT")"
    write_systemd_env_line PATH "$node_path"
    write_systemd_env_line SERVER_PORT "$server_port"
    write_systemd_env_line VITE_PORT "$vite_port"
    write_systemd_env_line HOST "$host"
    write_systemd_env_line DISABLE_AUTH "$disable_auth"
    write_systemd_env_line VITE_DISABLE_AUTH "$vite_disable_auth"
    write_systemd_env_line ANTIGRAVITY_PATH "$antigravity_path"
    write_systemd_env_line OPENCODE_PATH "$opencode_path"
    if [[ -n "$opencode_config" ]]; then
      write_systemd_env_line OPENCODE_CONFIG "$opencode_config"
    fi
    printf 'ExecStart=%s %s\n' \
      "$(systemd_quote "$node_bin")" \
      "$(systemd_quote "$REPO_ROOT/dist-server/server/index.js")"
    printf 'Restart=on-failure\n'
    printf 'RestartSec=5\n\n'
    printf '[Install]\n'
    printf 'WantedBy=default.target\n'
  } > "$service_file"

  print_step "Wrote $service_file"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SYSTEMD_SERVICE_NAME"

  if command_exists loginctl; then
    loginctl enable-linger "$USER" || print_warn "could not enable linger for $USER"
  fi

  if wait_for_url "$(backend_health_url)"; then
    print_step "Health check passed: $(backend_health_url)"
  else
    print_warn "service started, but health check did not pass yet: $(backend_health_url)"
  fi

  print_step "Status: systemctl --user status $SYSTEMD_SERVICE_NAME"
  print_step "Logs: journalctl --user -u $SYSTEMD_SERVICE_NAME -f"
}

install_macos_service() {
  command_exists launchctl || fail "launchctl is required for macOS service mode."

  local node_bin
  local node_path
  local plist_dir
  local plist_file
  local log_dir
  local server_port
  local vite_port
  local host
  local disable_auth
  local vite_disable_auth
  local antigravity_path
  local opencode_path
  local opencode_config

  node_bin="$(command -v node)"
  node_path="$(service_path_value "$node_bin")"
  plist_dir="$HOME/Library/LaunchAgents"
  plist_file="$plist_dir/${LAUNCHD_LABEL}.plist"
  log_dir="$HOME/Library/Logs/mcp-playground"
  server_port="$(env_value SERVER_PORT "$DEFAULT_SERVER_PORT")"
  vite_port="$(env_value VITE_PORT "$DEFAULT_VITE_PORT")"
  host="$(env_value HOST "$DEFAULT_HOST")"
  disable_auth="$(env_value DISABLE_AUTH "true")"
  vite_disable_auth="$(env_value VITE_DISABLE_AUTH "true")"
  antigravity_path="$(env_value ANTIGRAVITY_PATH "agy")"
  opencode_path="$(env_value OPENCODE_PATH "opencode")"
  opencode_config="$(env_optional_value OPENCODE_CONFIG)"

  mkdir -p "$plist_dir" "$log_dir"

  {
    cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
PLIST
    write_plist_string_entry "    " "Label" "$LAUNCHD_LABEL"
    write_plist_string_entry "    " "WorkingDirectory" "$REPO_ROOT"
    printf '    <key>ProgramArguments</key>\n'
    printf '    <array>\n'
    printf '      <string>%s</string>\n' "$(xml_escape "$node_bin")"
    printf '      <string>%s</string>\n' "$(xml_escape "$REPO_ROOT/dist-server/server/index.js")"
    printf '    </array>\n'
    printf '    <key>EnvironmentVariables</key>\n'
    printf '    <dict>\n'
    write_plist_string_entry "      " "PATH" "$node_path"
    write_plist_string_entry "      " "SERVER_PORT" "$server_port"
    write_plist_string_entry "      " "VITE_PORT" "$vite_port"
    write_plist_string_entry "      " "HOST" "$host"
    write_plist_string_entry "      " "DISABLE_AUTH" "$disable_auth"
    write_plist_string_entry "      " "VITE_DISABLE_AUTH" "$vite_disable_auth"
    write_plist_string_entry "      " "ANTIGRAVITY_PATH" "$antigravity_path"
    write_plist_string_entry "      " "OPENCODE_PATH" "$opencode_path"
    if [[ -n "$opencode_config" ]]; then
      write_plist_string_entry "      " "OPENCODE_CONFIG" "$opencode_config"
    fi
    printf '    </dict>\n'
    printf '    <key>RunAtLoad</key>\n'
    printf '    <true/>\n'
    printf '    <key>KeepAlive</key>\n'
    printf '    <true/>\n'
    write_plist_string_entry "    " "StandardOutPath" "$log_dir/out.log"
    write_plist_string_entry "    " "StandardErrorPath" "$log_dir/err.log"
    cat <<'PLIST'
  </dict>
</plist>
PLIST
  } > "$plist_file"

  print_step "Wrote $plist_file"
  launchctl bootout "gui/$(id -u)" "$plist_file" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_file"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"

  if wait_for_url "$(backend_health_url)"; then
    print_step "Health check passed: $(backend_health_url)"
  else
    print_warn "service started, but health check did not pass yet: $(backend_health_url)"
  fi

  print_step "Status: launchctl print gui/$(id -u)/$LAUNCHD_LABEL"
  print_step "Logs: tail -f $log_dir/err.log"
}

install_user_service() {
  build_production_server

  case "$(uname -s)" in
    Linux)
      install_linux_service
      ;;
    Darwin)
      install_macos_service
      ;;
    *)
      fail "macOS and Linux are supported by service mode."
      ;;
  esac
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --service)
        MODE="service"
        shift
        ;;
      --dev)
        MODE="dev"
        shift
        ;;
      --no-install)
        RUN_NPM_INSTALL="false"
        shift
        ;;
      --reinstall)
        FORCE_REINSTALL="true"
        shift
        ;;
      --rebuild-native)
        REBUILD_NATIVE="true"
        shift
        ;;
      --host)
        require_arg "$1" "${2-}"
        export HOST="$2"
        shift 2
        ;;
      --server-port|--backend-port)
        require_arg "$1" "${2-}"
        export SERVER_PORT="$2"
        shift 2
        ;;
      --vite-port|--frontend-port)
        require_arg "$1" "${2-}"
        export VITE_PORT="$2"
        shift 2
        ;;
      --auth)
        export DISABLE_AUTH="false"
        export VITE_DISABLE_AUTH="false"
        shift
        ;;
      --local-auth-disabled)
        export HOST="$DEFAULT_HOST"
        export DISABLE_AUTH="true"
        export VITE_DISABLE_AUTH="true"
        shift
        ;;
      --open)
        OPEN_BROWSER="true"
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

main() {
  parse_args "$@"
  check_supported_os
  check_repo_root
  require_node_runtime
  ensure_env_file
  install_dependencies

  if [[ "$MODE" == "service" ]]; then
    install_user_service
  else
    start_dev_server
  fi
}

main "$@"

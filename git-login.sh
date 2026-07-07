#!/usr/bin/env bash
set -euo pipefail

GIT_NAME="${GIT_NAME:-Gregg}"
GIT_EMAIL="${GIT_EMAIL:-gregg@pentera.cloud}"
INSTALL_NPM_DEPS="${INSTALL_NPM_DEPS:-1}"

if ! command -v apt >/dev/null 2>&1; then
  echo "This script expects a Debian/Ubuntu-style system with apt." >&2
  exit 1
fi

echo "Installing base Git/GitHub CLI prerequisites..."
sudo apt update
sudo apt install -y git wget curl ca-certificates build-essential python3

if command -v node >/dev/null 2>&1 && node -v | grep -Eq '^v22\.'; then
  echo "Node.js 22 is already installed."
else
  echo "Installing Node.js 22 for repo hooks and npm tooling..."
  tmp_nodesource="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$tmp_nodesource"
  sudo -E bash "$tmp_nodesource"
  sudo apt install -y nodejs
fi

echo "Adding the official GitHub CLI apt repository..."
sudo mkdir -p -m 755 /etc/apt/keyrings
tmp_key="$(mktemp)"
trap 'rm -f "${tmp_key:-}" "${tmp_nodesource:-}"' EXIT

wget -nv -O"$tmp_key" https://cli.github.com/packages/githubcli-archive-keyring.gpg
sudo install -m 644 "$tmp_key" /etc/apt/keyrings/githubcli-archive-keyring.gpg

sudo mkdir -p -m 755 /etc/apt/sources.list.d
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null

echo "Installing GitHub CLI..."
sudo apt update
sudo apt install -y gh

echo "Configuring Git identity..."
git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"

echo
echo "Git identity configured:"
git config --global --get user.name
git config --global --get user.email

echo
echo "Node/npm tooling:"
node -v
npm -v
npx -v

if [[ "$INSTALL_NPM_DEPS" == "1" && -f package-lock.json ]]; then
  echo
  echo "Installing repo npm dependencies..."
  npm ci
fi

echo
echo "Starting GitHub auth. Choose GitHub.com, SSH, then browser/device login."
gh auth login --hostname github.com --git-protocol ssh --web

echo
echo "GitHub auth status:"
gh auth status

echo
echo "Optional SSH check. A successful GitHub SSH auth message may still exit non-zero, so this is informational."
ssh -T git@github.com || true

echo
echo "Done. For an existing repo, check or switch the remote with:"
echo "  git remote -v"
echo "  git remote set-url origin git@github.com:OWNER/REPO.git"

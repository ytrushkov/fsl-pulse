#!/usr/bin/env bash
# bootstrap.sh — one-shot dev environment setup
set -euo pipefail

echo "==> Checking dependencies..."

check_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found. $2" >&2; exit 1; }
}

check_cmd docker  "Install Docker Desktop: https://docs.docker.com/desktop/"
check_cmd git     "Install git"
check_cmd python3 "Install Python 3.12+"

PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
REQUIRED="3.12"
if python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)"; then
  echo "  Python $PYTHON_VERSION OK"
else
  echo "ERROR: Python 3.12+ required, found $PYTHON_VERSION" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "==> Installing uv..."
  pip install --quiet uv
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> Installing pnpm..."
  npm install -g pnpm@9
fi

echo "==> Installing Python dependencies..."
uv sync --all-packages --dev

echo "==> Installing Node dependencies..."
pnpm install --frozen-lockfile

echo "==> Installing pre-commit hooks..."
uv run pre-commit install --install-hooks

if [[ ! -f .env ]]; then
  echo "==> Copying .env.example → .env..."
  cp .env.example .env
  echo "  Created .env — fill in REPLACE_WITH_* values before running 'make dev'."
fi

echo ""
echo "Bootstrap complete. Next steps:"
echo "  1. Edit .env and replace all REPLACE_WITH_* values"
echo "  2. Run: make dev"

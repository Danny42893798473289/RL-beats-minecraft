#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"

if ! command -v node >/dev/null; then
  echo "Node.js 22+ is required. Install it or place it at ~/.local/node."
  exit 1
fi
if ! command -v uv >/dev/null; then
  echo "uv is required: https://docs.astral.sh/uv/"
  exit 1
fi

cd "$ROOT/bridge"
npm install

cd "$ROOT/dashboard"
npm install

cd "$ROOT/trainer"
uv python install 3.12
uv sync --python 3.12

cd "$ROOT"
python3 scripts/download_paper.py
python3 scripts/generate_compose.py "${NUM_ENVS:-2}"
echo "Bootstrap complete."

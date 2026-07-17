#!/usr/bin/env bash
# Wipe world folders and restart Paper for one training worker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="${1:?server dir required}"
PORT="${2:?minecraft port required}"
PID_FILE="$SERVER_DIR/server.pid"
WAIT_SECS="${WIPE_WAIT_SECS:-300}"
LOG_FILE="$SERVER_DIR/server.log"

echo "Wiping world in $SERVER_DIR ..."

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

# Drop any leftover java still bound to this worker directory
pkill -f "paper.jar.*${SERVER_DIR}" 2>/dev/null || true
sleep 2

rm -rf \
  "$SERVER_DIR/world" \
  "$SERVER_DIR/world_nether" \
  "$SERVER_DIR/world_the_end" \
  "$SERVER_DIR/logs" \
  "$SERVER_DIR/cache"

# Fresh random seed so the next world is not a copy of the last one
SEED="$(python3 -c 'import random; print(random.randint(-(1 << 63), (1 << 63) - 1))')"
PROPS="$SERVER_DIR/server.properties"
if [[ -f "$PROPS" ]] && grep -q '^level-seed=' "$PROPS"; then
  sed -i "s/^level-seed=.*/level-seed=${SEED}/" "$PROPS"
elif [[ -f "$PROPS" ]]; then
  echo "level-seed=${SEED}" >> "$PROPS"
else
  echo "Missing $PROPS" >&2
  exit 1
fi
echo "New world seed: ${SEED}"

: > "$LOG_FILE"
"$ROOT/scripts/start_paper_worker.sh" "$SERVER_DIR"

server_ready() {
  # Prefer log "Done (...)" — TCP alone can race under memory pressure.
  if [[ -f "$LOG_FILE" ]] && grep -qE 'Done \([0-9.]+s\)! For help' "$LOG_FILE"; then
    return 0
  fi
  if (echo >"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; then
    # Port open but maybe still loading — require Done if log exists
    if [[ ! -f "$LOG_FILE" ]] || grep -qE 'Done \([0-9.]+s\)! For help' "$LOG_FILE"; then
      return 0
    fi
  fi
  return 1
}

java_alive() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

for ((t=1; t<=WAIT_SECS; t++)); do
  if server_ready; then
    echo "World wipe complete; server ready on :$PORT (${t}s)"
    exit 0
  fi
  if (( t % 30 == 0 )); then
    if ! java_alive; then
      echo "Paper died during wipe boot — restarting once..."
      "$ROOT/scripts/start_paper_worker.sh" "$SERVER_DIR"
    else
      echo "Still waiting for Paper on :$PORT (${t}/${WAIT_SECS}s)..."
    fi
  fi
  sleep 1
done

echo "Wipe restart timed out waiting for :$PORT after ${WAIT_SECS}s" >&2
if [[ -f "$LOG_FILE" ]]; then
  echo "---- last server.log lines ----" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
fi
exit 1

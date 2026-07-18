#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"

# Load defaults from config.json
eval "$(python3 "$ROOT/scripts/read_config.py")"

# CLI / env overrides
for arg in "$@"; do
  case "$arg" in
    --WIPE_EVERY_EPISODES=*) WIPE_EVERY_EPISODES="${arg#*=}" ;;
    --NUM_ENVS=*) NUM_ENVS="${arg#*=}" ;;
    --ENABLE_VIEWER=*) ENABLE_VIEWER="${arg#*=}" ;;
    --MC_XMX=*) MC_XMX="${arg#*=}" ;;
    --SHARED_SERVER=*) SHARED_SERVER="${arg#*=}" ;;
    --PAD_SPACING=*) PAD_SPACING="${arg#*=}" ;;
  esac
done

PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pidfile in "$ROOT"/runtime/mc*/server.pid; do
    [[ -f "$pidfile" ]] || continue
    kill "$(cat "$pidfile")" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# Kill leftover Paper/bridges from a previous Ctrl+C so session.lock is not held.
kill_stale_runtime() {
  echo "Clearing stale Paper / bridge processes..."
  for pidfile in "$ROOT"/runtime/mc*/server.pid; do
    [[ -f "$pidfile" ]] || continue
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
      echo "  stopping old Paper pid=$old"
      kill "$old" 2>/dev/null || true
      sleep 1
      kill -9 "$old" 2>/dev/null || true
    fi
  done
  # Anything still bound to our MC / bridge / viewer / status ports
  if command -v fuser >/dev/null 2>&1; then
    for ((i=0; i<NUM_ENVS; i++)); do
      fuser -k "${MC_PORT}/tcp" >/dev/null 2>&1 || true
      fuser -k "$((RCON_PORT))/tcp" >/dev/null 2>&1 || true
      fuser -k "$((WS_BASE_PORT + i))/tcp" >/dev/null 2>&1 || true
      fuser -k "$((VIEWER_BASE_PORT + i))/tcp" >/dev/null 2>&1 || true
      fuser -k "$((STATUS_BASE_PORT + i))/tcp" >/dev/null 2>&1 || true
    done
    fuser -k "${DASHBOARD_PORT}/tcp" >/dev/null 2>&1 || true
  else
    # Fallback: kill java paper.jar under our runtime tree
    pkill -f "$ROOT/runtime/mc.*/paper.jar" 2>/dev/null || true
    pkill -f "$ROOT/bridge.*npm start" 2>/dev/null || true
  fi
  sleep 1
  # Drop stale world locks so Paper can boot
  find "$ROOT/runtime" -name 'session.lock' -delete 2>/dev/null || true
}

python3 "$ROOT/scripts/download_paper.py"
mkdir -p "$ROOT/runtime"
chmod +x "$ROOT/scripts/start_paper_worker.sh" "$ROOT/scripts/wipe_world.sh" "$ROOT/scripts/read_config.py"
kill_stale_runtime

wait_for_port() {
  local port="$1"
  local tries=180
  for ((t=0; t<tries; t++)); do
    if (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_paper_ready() {
  local server_dir="$1"
  local port="$2"
  local pid
  pid="$(cat "$server_dir/server.pid" 2>/dev/null || true)"
  local tries=180
  for ((t=0; t<tries; t++)); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "Paper pid $pid exited early — see $server_dir/server.log"
      tail -n 20 "$server_dir/server.log" || true
      return 1
    fi
    if grep -qE 'Done \(|For help, type "help"' "$server_dir/server.log" 2>/dev/null; then
      if (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "Timed out waiting for Paper Done on :$port"
  tail -n 30 "$server_dir/server.log" || true
  return 1
}

write_server_props() {
  local server_dir="$1"
  local server_port="$2"
  local rcon_port="$3"
  mkdir -p "$server_dir"
  sed \
    -e "s/{{SERVER_PORT}}/${server_port}/g" \
    -e "s/{{RCON_PORT}}/${rcon_port}/g" \
    -e "s/{{MAX_PLAYERS}}/${MAX_PLAYERS}/g" \
    "$ROOT/mc/server.properties.template" > "$server_dir/server.properties"
  cp "$ROOT/mc/spigot.yml" "$server_dir/spigot.yml"
  local seed
  seed="$(python3 -c 'import random; print(random.randint(-(1 << 63), (1 << 63) - 1))')"
  if grep -q '^level-seed=' "$server_dir/server.properties"; then
    sed -i "s/^level-seed=.*/level-seed=${seed}/" "$server_dir/server.properties"
  else
    echo "level-seed=${seed}" >> "$server_dir/server.properties"
  fi
}

start_bridge() {
  local i="$1"
  local mc_port="$2"
  local rcon_port="$3"
  local server_dir="$4"
  (
    cd "$ROOT/bridge"
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}"
    export MC_HOST="127.0.0.1"
    export MC_PORT="$mc_port"
    export RCON_HOST="127.0.0.1"
    export RCON_PORT="$rcon_port"
    export WS_PORT="$((WS_BASE_PORT + i))"
    export VIEWER_PORT="$((VIEWER_BASE_PORT + i))"
    export STATUS_PORT="$((STATUS_BASE_PORT + i))"
    export BOT_USERNAME="rl_bot_$i"
    export BOT_RANK="$i"
    export PAD_SPACING="$PAD_SPACING"
    export SHARED_SERVER="$SHARED_SERVER"
    export MC_SERVER_DIR="$server_dir"
    export WIPE_EVERY_EPISODES="$WIPE_EVERY_EPISODES"
    export ENABLE_VIEWER="$ENABLE_VIEWER"
    export DAMAGE_REACTION="${DAMAGE_REACTION:-flee}"
    export STAGE="${STAGE:-2}"
    export ACTION_TIMEOUT_MS="$ACTION_TIMEOUT_MS"
    export EPISODE_STEPS="$EPISODE_STEPS"
    export MOVE_MS="$MOVE_MS"
    export WAIT_MS="$WAIT_MS"
    export COLLECT_BUDGET_MS="$COLLECT_BUDGET_MS"
    export PATH_TIMEOUT_MS="$PATH_TIMEOUT_MS"
    export SOFT_RESET_SLEEP_MS="$SOFT_RESET_SLEEP_MS"
    # Auto-restart if Node OOMs / crashes so training can reconnect
    while true; do
      echo "[bridge$i] starting $(date -Iseconds)" 
      npm start || true
      echo "[bridge$i] exited — restarting in 3s" 
      sleep 3
    done
  ) > "$ROOT/runtime/bridge$i.log" 2>&1 &
  PIDS+=("$!")
}

if [[ "$SHARED_SERVER" == "1" ]]; then
  server_dir="$ROOT/runtime/mc0"
  write_server_props "$server_dir" "$MC_PORT" "$RCON_PORT"
  echo "Starting shared Paper (heap ${MC_XMS}-${MC_XMX}, max-players ${MAX_PLAYERS})..."
  # Truncate log so we detect THIS boot's "Done", not a previous run
  : > "$server_dir/server.log"
  MC_XMS="$MC_XMS" MC_XMX="$MC_XMX" "$ROOT/scripts/start_paper_worker.sh" "$server_dir"
  PIDS+=("$(cat "$server_dir/server.pid")")
  if ! wait_for_paper_ready "$server_dir" "$MC_PORT"; then
    exit 1
  fi
  echo "  shared Paper ready on :$MC_PORT"

  for ((i=0; i<NUM_ENVS; i++)); do
    start_bridge "$i" "$MC_PORT" "$RCON_PORT" "$server_dir"
    sleep 0.5
  done
  echo "Waiting for bots to spawn (parallel, up to 120s)..."
  deadline=$((SECONDS + 120))
  declare -a bot_ready=()
  for ((i=0; i<NUM_ENVS; i++)); do bot_ready[i]=0; done
  while (( SECONDS < deadline )); do
    all_ok=1
    for ((i=0; i<NUM_ENVS; i++)); do
      if (( bot_ready[i] )); then continue; fi
      status_port=$((STATUS_BASE_PORT + i))
      if curl -sf --max-time 1 "http://127.0.0.1:${status_port}/status" 2>/dev/null | grep -q '"ready":true'; then
        bot_ready[i]=1
        echo "  rl_bot_$i ready"
      else
        all_ok=0
      fi
    done
    if (( all_ok )); then break; fi
    sleep 2
  done
  for ((i=0; i<NUM_ENVS; i++)); do
    if (( ! bot_ready[i] )); then
      echo "  rl_bot_$i NOT ready — see runtime/bridge$i.log"
    fi
  done
  MODE_MSG="shared Paper :${MC_PORT}; bots on pads every ${PAD_SPACING} blocks; stage ${STAGE}"
else
  for ((i=0; i<NUM_ENVS; i++)); do
    server_dir="$ROOT/runtime/mc$i"
    write_server_props "$server_dir" "$((MC_PORT + i))" "$((RCON_PORT + i))"
    if (( i > 0 )); then sleep 3; fi
    MC_XMS="$MC_XMS" MC_XMX="$MC_XMX" "$ROOT/scripts/start_paper_worker.sh" "$server_dir"
    PIDS+=("$(cat "$server_dir/server.pid")")
  done
  echo "Waiting for Paper workers..."
  for ((i=0; i<NUM_ENVS; i++)); do
    port=$((MC_PORT + i))
    if ! wait_for_port "$port"; then
      echo "Timed out waiting for mc$i on :$port"
      exit 1
    fi
    echo "  mc$i ready on :$port"
  done
  for ((i=0; i<NUM_ENVS; i++)); do
    start_bridge "$i" "$((MC_PORT + i))" "$((RCON_PORT + i))" "$ROOT/runtime/mc$i"
  done
  MODE_MSG="isolated Paper per bot"
fi

(
  cd "$ROOT/dashboard"
  NUM_ENVS="$NUM_ENVS" \
  DASHBOARD_PORT="$DASHBOARD_PORT" \
  STATUS_BASE_PORT="$STATUS_BASE_PORT" \
  VIEWER_BASE_PORT="$VIEWER_BASE_PORT" \
  WS_BASE_PORT="$WS_BASE_PORT" \
  MC_PORT="$MC_PORT" \
  SHARED_SERVER="$SHARED_SERVER" \
  exec npm start
) > "$ROOT/runtime/dashboard.log" 2>&1 &
PIDS+=("$!")

echo "$NUM_ENVS bots running ($MODE_MSG)."
echo "Stage ${STAGE} (from config.json). Wipe every ${WIPE_EVERY_EPISODES} episodes (rank 0 only when shared)."
echo "Viewer: $([ "$ENABLE_VIEWER" = "1" ] && echo on || echo off)  Dashboard: http://127.0.0.1:${DASHBOARD_PORT}"
echo "Train: cd trainer && uv run python train.py"
wait

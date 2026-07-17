#!/usr/bin/env bash
# Start one Paper worker and write server.pid for wipe/restart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="${1:?server dir required}"
MC_XMS="${MC_XMS:-256M}"
MC_XMX="${MC_XMX:-700M}"

mkdir -p "$SERVER_DIR"
if [[ ! -f "$SERVER_DIR/paper.jar" ]]; then
  cp "$ROOT/mc/paper-1.21.4.jar" "$SERVER_DIR/paper.jar"
fi
echo "eula=true" > "$SERVER_DIR/eula.txt"

cd "$SERVER_DIR"
java \
  -Xms"$MC_XMS" -Xmx"$MC_XMX" \
  -XX:+UseG1GC \
  -XX:+ParallelRefProcEnabled \
  -XX:MaxGCPauseMillis=100 \
  -XX:+UnlockExperimentalVMOptions \
  -XX:+DisableExplicitGC \
  -XX:G1NewSizePercent=20 \
  -XX:G1MaxNewSizePercent=40 \
  -XX:G1HeapRegionSize=4M \
  -XX:G1ReservePercent=15 \
  -XX:InitiatingHeapOccupancyPercent=20 \
  -XX:G1HeapWastePercent=5 \
  -XX:G1MixedGCCountTarget=4 \
  -XX:G1MixedGCLiveThresholdPercent=90 \
  -XX:G1RSetUpdatingPauseTimePercent=5 \
  -XX:SurvivorRatio=32 \
  -XX:+PerfDisableSharedMem \
  -XX:MaxTenuringThreshold=1 \
  -jar paper.jar --nogui \
  >>"$SERVER_DIR/server.log" 2>&1 &
echo $! > "$SERVER_DIR/server.pid"
echo "Started Paper pid=$(cat "$SERVER_DIR/server.pid") in $SERVER_DIR"

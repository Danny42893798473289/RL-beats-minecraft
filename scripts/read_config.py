#!/usr/bin/env python3
"""Load project config.json and print shell KEY=value lines (or one JSON field)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "num_bots": 10,
    "stage": 2,
    "wipe_every_episodes": 25,
    "enable_viewer": True,
    "shared_server": True,
    "pad_spacing": 1000,
    "mc_xms": "512M",
    "mc_xmx": "4G",
    "max_players": 16,
    "episode_steps": 256,
    "action_timeout_ms": 12000,
    "move_ms": 70,
    "wait_ms": 20,
    "path_timeout_ms": 1200,
    "collect_budget_ms": 900,
    "soft_reset_sleep_ms": 250,
    "ws_base_port": 8765,
    "viewer_base_port": 3000,
    "status_base_port": 8865,
    "dashboard_port": 8080,
    "mc_port": 25565,
    "rcon_port": 25575,
    "timesteps": 1000000,
    "save_freq": 2000,
}


def load_config() -> dict:
    path = ROOT / "config.json"
    data = dict(DEFAULTS)
    if path.is_file():
        with path.open(encoding="utf-8") as handle:
            data.update(json.load(handle))
    return data


def as_shell(cfg: dict) -> str:
    mapping = {
        "NUM_ENVS": cfg["num_bots"],
        "STAGE": cfg["stage"],
        "WIPE_EVERY_EPISODES": cfg["wipe_every_episodes"],
        "ENABLE_VIEWER": "1" if cfg["enable_viewer"] else "0",
        "SHARED_SERVER": "1" if cfg["shared_server"] else "0",
        "PAD_SPACING": cfg["pad_spacing"],
        "MC_XMS": cfg["mc_xms"],
        "MC_XMX": cfg["mc_xmx"],
        "MAX_PLAYERS": cfg["max_players"],
        "EPISODE_STEPS": cfg["episode_steps"],
        "ACTION_TIMEOUT_MS": cfg["action_timeout_ms"],
        "MOVE_MS": cfg["move_ms"],
        "WAIT_MS": cfg["wait_ms"],
        "PATH_TIMEOUT_MS": cfg["path_timeout_ms"],
        "COLLECT_BUDGET_MS": cfg["collect_budget_ms"],
        "SOFT_RESET_SLEEP_MS": cfg["soft_reset_sleep_ms"],
        "WS_BASE_PORT": cfg["ws_base_port"],
        "VIEWER_BASE_PORT": cfg["viewer_base_port"],
        "STATUS_BASE_PORT": cfg["status_base_port"],
        "DASHBOARD_PORT": cfg["dashboard_port"],
        "MC_PORT": cfg["mc_port"],
        "RCON_PORT": cfg["rcon_port"],
        "TIMESTEPS": cfg["timesteps"],
        "SAVE_FREQ": cfg["save_freq"],
    }
    lines = []
    for key, value in mapping.items():
        lines.append(f'{key}={json.dumps(str(value))}')
    return "\n".join(lines)


def main() -> None:
    cfg = load_config()
    if len(sys.argv) == 2 and sys.argv[1] == "--json":
        print(json.dumps(cfg))
        return
    if len(sys.argv) == 2:
        key = sys.argv[1]
        if key not in cfg:
            raise SystemExit(f"unknown config key: {key}")
        value = cfg[key]
        if isinstance(value, bool):
            print("1" if value else "0")
        else:
            print(value)
        return
    print(as_shell(cfg))


if __name__ == "__main__":
    main()

"""Record (obs, action) from successful Mineflayer episodes for success-replay BC."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np


class SuccessReplayWrapper(gym.Wrapper):
    """Buffer transitions; on info['success'] append discrete (obs, action) JSONL rows."""

    def __init__(
        self,
        env: gym.Env,
        path: Path,
        stage: int,
        *,
        max_episodes: int = 500,
    ) -> None:
        super().__init__(env)
        self.path = Path(path)
        self.stage = int(stage)
        self.max_episodes = max_episodes
        self._traj: list[dict[str, Any]] = []
        self._last_obs: np.ndarray | None = None
        self._episodes_written = 0
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        self._traj = []
        obs, info = self.env.reset(seed=seed, options=options)
        self._last_obs = np.asarray(obs, dtype=np.float32)
        return obs, info

    def step(self, action: Any):
        obs, reward, terminated, truncated, info = self.env.step(action)
        if self._last_obs is not None and self._episodes_written < self.max_episodes:
            self._traj.append(
                {
                    "obs": self._last_obs.astype(np.float32).tolist(),
                    "action": int(action),
                    "stage": self.stage,
                }
            )
        success = bool(info.get("success"))
        if success and self._traj and self._episodes_written < self.max_episodes:
            self._flush_success()
        if terminated or truncated:
            self._traj = []
        self._last_obs = np.asarray(obs, dtype=np.float32)
        return obs, reward, terminated, truncated, info

    def _flush_success(self) -> None:
        with self._lock:
            if self._episodes_written >= self.max_episodes:
                self._traj = []
                return
            with self.path.open("a", encoding="utf-8") as handle:
                for row in self._traj:
                    handle.write(json.dumps(row, separators=(",", ":")) + "\n")
            self._episodes_written += 1
            self._traj = []


def is_success_replay_row(row: dict[str, Any]) -> bool:
    """True when JSONL row already has discrete Mineflayer action + obs vector."""
    action = row.get("action")
    obs = row.get("obs")
    return isinstance(action, int) and isinstance(obs, list) and len(obs) > 0

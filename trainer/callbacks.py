"""Training helpers: auto-save best by ep_rew_mean, early-stop on collapse."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from stable_baselines3.common.callbacks import BaseCallback


class BestAndEarlyStopCallback(BaseCallback):
    """
    - Save ``*_best.zip`` when rollout ep_rew_mean improves.
    - Persist peak in ``*_best.json`` so a cold first rollout cannot overwrite it.
    - Stop learning if reward stays >drop_below below peak for patience iters.
    - Log mean bridge step/reset time from env infos.
    """

    def __init__(
        self,
        checkpoint_dir: Path,
        name_prefix: str,
        *,
        drop_below: float = 3.0,
        patience_iters: int = 5,
        min_iters_before_stop: int = 8,
        verbose: int = 1,
    ) -> None:
        super().__init__(verbose)
        self.checkpoint_dir = Path(checkpoint_dir)
        self.name_prefix = name_prefix
        self.drop_below = drop_below
        self.patience_iters = patience_iters
        self.min_iters_before_stop = min_iters_before_stop
        self.best_rew = -np.inf
        self.bad_streak = 0
        self.iters = 0
        self._stop = False
        self._step_ms: list[float] = []
        self._reset_ms: list[float] = []
        self._load_best_meta()

    def _meta_path(self) -> Path:
        return self.checkpoint_dir / f"{self.name_prefix}_best.json"

    def _best_zip_path(self) -> Path:
        return self.checkpoint_dir / f"{self.name_prefix}_best.zip"

    def _load_best_meta(self) -> None:
        path = self._meta_path()
        if not path.is_file():
            return
        try:
            with path.open(encoding="utf-8") as handle:
                data = json.load(handle)
            raw = data.get("best_rew")
            if raw is None:
                return
            score = float(raw)
            if np.isfinite(score):
                self.best_rew = score
                if self.verbose:
                    print(f"[best] loaded peak {score:.3f} from {path}")
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            if self.verbose:
                print(f"[best] could not read {path}: {exc}")

    def _save_best_meta(self, ep_rew: float) -> None:
        path = self._meta_path()
        payload = {
            "best_rew": float(ep_rew),
            "timesteps": int(getattr(self.model, "num_timesteps", 0) or 0),
            "name_prefix": self.name_prefix,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")

    def _on_training_start(self) -> None:
        self._stop = False

    def _on_step(self) -> bool:
        infos = self.locals.get("infos") or []
        for info in infos:
            if not isinstance(info, dict):
                continue
            step_ms = info.get("stepMs")
            reset_ms = info.get("resetMs")
            if step_ms is not None:
                self._step_ms.append(float(step_ms))
            if reset_ms is not None:
                self._reset_ms.append(float(reset_ms))
        return not self._stop

    def _mean_ep_rew(self) -> float | None:
        # SB3 fills ep_info_buffer from Monitor before _on_rollout_end.
        # The printed logger value is written later, so it is empty here.
        buf = getattr(self.model, "ep_info_buffer", None)
        if not buf:
            return None
        rewards = [float(ep["r"]) for ep in buf if isinstance(ep, dict) and "r" in ep]
        if not rewards:
            return None
        return float(np.mean(rewards))

    def _on_rollout_end(self) -> None:
        self.iters += 1
        if self._step_ms:
            self.logger.record("time/step_ms", float(np.mean(self._step_ms)))
            self._step_ms.clear()
        if self._reset_ms:
            self.logger.record("time/reset_ms", float(np.mean(self._reset_ms)))
            self._reset_ms.clear()

        ep_rew = self._mean_ep_rew()
        if ep_rew is None or not np.isfinite(ep_rew):
            return

        best_path = self._best_zip_path()
        if ep_rew > self.best_rew:
            self.best_rew = ep_rew
            self.bad_streak = 0
            tmp = self.checkpoint_dir / f"{self.name_prefix}_best"
            self.model.save(str(tmp))
            self._save_best_meta(ep_rew)
            if self.verbose:
                print(f"[best] ep_rew_mean={ep_rew:.3f} → {best_path}")
            return

        if ep_rew < self.best_rew - self.drop_below:
            self.bad_streak += 1
            if self.verbose:
                print(
                    f"[early-stop watch] ep_rew={ep_rew:.3f} "
                    f"best={self.best_rew:.3f} streak={self.bad_streak}/{self.patience_iters}"
                )
        else:
            self.bad_streak = 0

        if (
            self.iters >= self.min_iters_before_stop
            and self.bad_streak >= self.patience_iters
        ):
            if self.verbose:
                print(
                    f"[early-stop] reward {ep_rew:.3f} stayed >{self.drop_below} "
                    f"below peak {self.best_rew:.3f} for {self.patience_iters} iters. "
                    f"Reload {best_path}"
                )
            self.model.save(str(self.checkpoint_dir / f"{self.name_prefix}_final"))
            self._stop = True

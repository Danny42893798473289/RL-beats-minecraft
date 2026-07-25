"""Behavior-clone a PPO policy from Fabric demo JSONL files."""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv
from torch.utils.data import DataLoader, TensorDataset

from agents import build_ppo
from demo_mapper import OBSERVATION_SIZE, build_observation, map_action
from env.minecraft_env import MinecraftEnv

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class OfflineEnv(MinecraftEnv):
    """Env stub so SB3 can build a policy without a live bridge."""

    def reset(self, *, seed=None, options=None):  # type: ignore[override]
        return np.zeros(OBSERVATION_SIZE, dtype=np.float32), {}

    def step(self, action):  # type: ignore[override]
        return np.zeros(OBSERVATION_SIZE, dtype=np.float32), 0.0, True, False, {}

    def _connect(self, *, force: bool = False, raise_on_fail: bool = True) -> bool:
        return False


def load_demos(demo_paths: list[Path], stage: int | None) -> tuple[np.ndarray, np.ndarray]:
    obs_list: list[list[float]] = []
    act_list: list[int] = []
    for path in demo_paths:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                row: dict[str, Any] = json.loads(line)
                obs_list.append(build_observation(row, stage=stage))
                act_list.append(map_action(row))
    if not obs_list:
        raise SystemExit(f"no demo rows found in {demo_paths}")
    obs = np.asarray(obs_list, dtype=np.float32)
    acts = np.asarray(act_list, dtype=np.int64)
    return obs, acts


def collect_demo_files(demos: Path) -> list[Path]:
    if demos.is_file():
        return [demos]
    files = sorted(demos.glob("*.jsonl"))
    if not files:
        raise SystemExit(f"no .jsonl demos under {demos}")
    return files


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Behavior clone from Fabric demo JSONL")
    parser.add_argument("--demos", type=Path, default=PROJECT_ROOT / "demos")
    parser.add_argument("--out", type=Path, default=PROJECT_ROOT / "checkpoints" / "bc_policy.zip")
    parser.add_argument("--stage", type=int, default=None, help="Override stage_hint in demos")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--load", type=Path, help="Optional existing PPO zip to fine-tune with BC")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    demo_files = collect_demo_files(args.demos)
    obs, acts = load_demos(demo_files, args.stage)
    print(f"Loaded {len(obs)} ticks from {len(demo_files)} demo file(s)")
    unique, counts = np.unique(acts, return_counts=True)
    top = sorted(zip(unique.tolist(), counts.tolist()), key=lambda x: -x[1])[:8]
    print("Top mapped actions:", top)

    # Dummy env only to construct matching PPO policy (no Minecraft needed).
    vec = DummyVecEnv([
        lambda: OfflineEnv(url="ws://127.0.0.1:9", stage=args.stage or 0, connect_retries=0)
    ])

    if args.load:
        model = PPO.load(args.load, env=vec, device=args.device)
    else:
        model = build_ppo(vec, device=args.device)

    device = model.device
    policy = model.policy
    policy.train()

    dataset = TensorDataset(torch.from_numpy(obs), torch.from_numpy(acts))
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, drop_last=False)
    optim = torch.optim.Adam(policy.parameters(), lr=args.lr)

    for epoch in range(1, args.epochs + 1):
        total_loss = 0.0
        total_n = 0
        correct = 0
        for batch_obs, batch_acts in loader:
            batch_obs = batch_obs.to(device)
            batch_acts = batch_acts.to(device)
            # SB3 MlpPolicy: features → action_net logits via evaluate / get_distribution
            dist = policy.get_distribution(batch_obs)
            log_prob = dist.distribution.log_prob(batch_acts)
            loss = -log_prob.mean()
            optim.zero_grad()
            loss.backward()
            optim.step()
            total_loss += float(loss.item()) * len(batch_acts)
            total_n += len(batch_acts)
            pred = dist.distribution.probs.argmax(dim=-1)
            correct += int((pred == batch_acts).sum().item())
        acc = correct / max(1, total_n)
        print(f"epoch {epoch}/{args.epochs}  loss={total_loss / max(1, total_n):.4f}  acc={acc:.3f}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Save without trailing .zip duplication
    out = args.out
    if out.suffix == ".zip":
        model.save(str(out.with_suffix("")))
        saved = out if out.exists() else Path(str(out.with_suffix("")) + ".zip")
    else:
        model.save(str(out))
        saved = Path(str(out) + ".zip")
    print(f"Saved BC policy to {saved}")
    print(f"Next: uv run python train.py --stage {args.stage or 'N'} --load {saved}")
    vec.close()


if __name__ == "__main__":
    main()

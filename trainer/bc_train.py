"""Behavior-clone a PPO policy from Fabric demos or Mineflayer success-replay JSONL."""
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
from demo_mapper import ACTION_NAME_TO_ID, OBSERVATION_SIZE, build_observation, map_action
from env.minecraft_env import MinecraftEnv
from success_buffer import is_success_replay_row

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WAIT_ID = ACTION_NAME_TO_ID["WAIT"]
CRAFT_NEXT_ID = ACTION_NAME_TO_ID["CRAFT_NEXT"]
PLACE_HELD_ID = ACTION_NAME_TO_ID["PLACE_HELD"]
# Invented skill slot for furnace milestone (PRIMITIVES=20 + index 6).
INVENTED_FURNACE_ID = 20 + 6
# How many times to repeat craft-path labels so BC does not drown in dig noise.
CRAFT_UPSAMPLE = {
    CRAFT_NEXT_ID: 24,
    PLACE_HELD_ID: 8,
    INVENTED_FURNACE_ID: 16,
}


class OfflineEnv(MinecraftEnv):
    """Env stub so SB3 can build a policy without a live bridge."""

    def reset(self, *, seed=None, options=None):  # type: ignore[override]
        return np.zeros(OBSERVATION_SIZE, dtype=np.float32), {}

    def step(self, action):  # type: ignore[override]
        return np.zeros(OBSERVATION_SIZE, dtype=np.float32), 0.0, True, False, {}

    def _connect(self, *, force: bool = False, raise_on_fail: bool = True) -> bool:
        return False


def load_demos(
    demo_paths: list[Path],
    stage: int | None,
    *,
    wait_keep: float = 0.15,
    seed: int = 0,
    prefer_new_obs: bool = True,
    new_obs_start: int = 44,
) -> tuple[np.ndarray, np.ndarray]:
    rng = random.Random(seed)
    obs_list: list[list[float]] = []
    act_list: list[int] = []
    kept_wait = 0
    dropped_wait = 0
    success_rows = 0
    mapped_rows = 0
    skipped_legacy_obs = 0
    for path in demo_paths:
        prev: dict[str, Any] | None = None
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                row: dict[str, Any] = json.loads(line)
                from_success = is_success_replay_row(row)
                if from_success:
                    obs = [float(x) for x in row["obs"][:OBSERVATION_SIZE]]
                    while len(obs) < OBSERVATION_SIZE:
                        obs.append(0.0)
                    # Prefer success rows recorded after craft/hazard slots filled.
                    if prefer_new_obs and not any(obs[new_obs_start:OBSERVATION_SIZE]):
                        skipped_legacy_obs += 1
                        continue
                    action = int(row["action"])
                    success_rows += 1
                else:
                    action = map_action(row, prev)
                    prev = row
                    obs = build_observation(row, stage=stage)
                    mapped_rows += 1
                if action == WAIT_ID and rng.random() > wait_keep:
                    dropped_wait += 1
                    continue
                if action == WAIT_ID:
                    kept_wait += 1
                # Drop noisy invented macros except the furnace skill.
                if from_success and action >= 20 and action != INVENTED_FURNACE_ID:
                    continue
                copies = CRAFT_UPSAMPLE.get(action, 1)
                for _ in range(copies):
                    obs_list.append(list(obs))
                    act_list.append(action)
    if not obs_list:
        raise SystemExit(
            f"no demo rows found in {demo_paths}"
            + (f" (skipped {skipped_legacy_obs} legacy-obs success rows)" if skipped_legacy_obs else "")
        )
    print(
        f"WAIT keep={kept_wait} drop={dropped_wait} (keep_ratio={wait_keep}); "
        f"success_replay={success_rows} fabric_mapped={mapped_rows}"
        + (f" skipped_legacy_obs={skipped_legacy_obs}" if skipped_legacy_obs else "")
    )
    obs = np.asarray(obs_list, dtype=np.float32)
    acts = np.asarray(act_list, dtype=np.int64)
    return obs, acts


def collect_demo_files(demos: Path) -> list[Path]:
    if demos.is_file():
        return [demos]
    files = sorted(demos.glob("success_*.jsonl"))
    files += sorted(demos.glob("demo_*.jsonl"))
    if not files:
        files = sorted(demos.glob("*.jsonl"))
    if not files:
        raise SystemExit(f"no .jsonl demos under {demos}")
    return files


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Behavior clone from success-replay or Fabric demo JSONL"
    )
    parser.add_argument("--demos", type=Path, default=PROJECT_ROOT / "demos")
    parser.add_argument("--out", type=Path, default=PROJECT_ROOT / "checkpoints" / "bc_policy.zip")
    parser.add_argument("--stage", type=int, default=None, help="Override stage_hint in demos")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--wait-keep", type=float, default=0.15, help="Fraction of WAIT ticks to keep")
    parser.add_argument(
        "--prefer-new-obs",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="For success-replay rows, keep only ticks with filled slots 44+ (default on)",
    )
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
    obs, acts = load_demos(
        demo_files,
        args.stage,
        wait_keep=args.wait_keep,
        seed=args.seed,
        prefer_new_obs=args.prefer_new_obs,
    )
    print(f"Loaded {len(obs)} ticks from {len(demo_files)} demo file(s)")
    unique, counts = np.unique(acts, return_counts=True)
    top = sorted(zip(unique.tolist(), counts.tolist()), key=lambda x: -x[1])[:8]
    print("Top mapped actions:", top)

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
    out = args.out
    if out.suffix == ".zip":
        model.save(str(out.with_suffix("")))
        saved = out if out.exists() else Path(str(out.with_suffix("")) + ".zip")
    else:
        model.save(str(out))
        saved = Path(str(out) + ".zip")
    print(f"Saved BC policy to {saved}")
    print("Abort PPO if entropy_loss rises above ~-2.5 (toward 0).")
    print(f"Next: uv run python train.py --stage {args.stage or 'N'} --load {saved}")
    vec.close()


if __name__ == "__main__":
    main()

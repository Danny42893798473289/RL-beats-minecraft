import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

from stable_baselines3.common.callbacks import CheckpointCallback, CallbackList
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import SubprocVecEnv

from agents import build_ppo
from callbacks import BestAndEarlyStopCallback
from env import MinecraftEnv
from env.curriculum import STAGES, stage_by_id
from success_buffer import SuccessReplayWrapper

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_project_config() -> dict[str, Any]:
    path = PROJECT_ROOT / "config.json"
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def make_env(url: str, stage: int, success_path: Path | None) -> Callable[[], Monitor]:
    def create() -> Monitor:
        env: Any = MinecraftEnv(url=url, stage=stage)
        if success_path is not None:
            env = SuccessReplayWrapper(env, success_path, stage=stage)
        return Monitor(env)

    return create


def parse_args() -> argparse.Namespace:
    cfg = load_project_config()
    default_stage = int(cfg.get("stage", os.getenv("STAGE", "1")))
    default_envs = int(cfg.get("num_bots", os.getenv("NUM_ENVS", "3")))
    default_port = int(cfg.get("ws_base_port", os.getenv("WS_BASE_PORT", "8765")))
    default_steps = int(cfg.get("timesteps", 1_000_000))
    default_save = int(cfg.get("save_freq", 2000))

    parser = argparse.ArgumentParser(description="Train hierarchical Minecraft skill policies")
    parser.add_argument("--stage", type=int, default=default_stage, choices=range(len(STAGES)))
    parser.add_argument("--num-envs", type=int, default=default_envs)
    parser.add_argument("--base-port", type=int, default=default_port)
    parser.add_argument("--timesteps", type=int, default=default_steps)
    parser.add_argument("--save-freq", type=int, default=default_save)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--load", type=Path)
    parser.add_argument(
        "--lr",
        type=float,
        default=1e-4,
        help="Learning rate used when --load is set (fine-tune). Fresh runs keep 3e-4.",
    )
    parser.add_argument(
        "--clip-range",
        type=float,
        default=0.1,
        help="PPO clip range used when --load is set. Fresh runs keep 0.2.",
    )
    parser.add_argument(
        "--ent-coef",
        type=float,
        default=0.005,
        help="Entropy coef when --load is set (default 0.005). Fresh runs keep 0.02.",
    )
    parser.add_argument(
        "--zero-new-obs",
        action="store_true",
        help="Zero first-layer cols 44+ on --load (only for pre-craft-bit checkpoints).",
    )
    parser.add_argument(
        "--success-demos",
        type=Path,
        default=None,
        help="JSONL path for success-replay (default: demos/success_stage_<id>.jsonl)",
    )
    parser.add_argument(
        "--no-success-replay",
        action="store_true",
        help="Disable logging successful episodes for BC",
    )
    parser.add_argument("--no-early-stop", action="store_true", help="Disable best/early-stop callback")
    default_checkpoints = PROJECT_ROOT / "checkpoints"
    parser.add_argument("--checkpoint-dir", type=Path, default=default_checkpoints)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    stage = stage_by_id(args.stage)
    urls = [f"ws://127.0.0.1:{args.base_port + rank}" for rank in range(args.num_envs)]
    print(
        f"Training stage {stage.id} ({stage.name}) with {args.num_envs} envs "
        f"on ports {args.base_port}-{args.base_port + args.num_envs - 1}",
        file=sys.stderr,
    )

    success_path = None
    if not args.no_success_replay:
        success_path = args.success_demos or (
            PROJECT_ROOT / "demos" / f"success_stage_{stage.id}.jsonl"
        )
        print(f"Success-replay log: {success_path}", file=sys.stderr)

    vector_env = SubprocVecEnv(
        [make_env(url, stage.id, success_path) for url in urls],
        start_method="spawn",
    )
    args.checkpoint_dir.mkdir(parents=True, exist_ok=True)
    name_prefix = f"stage_{stage.id}_{stage.name}"
    final_path = args.checkpoint_dir / f"{name_prefix}_final"
    checkpoint = CheckpointCallback(
        save_freq=max(args.save_freq, 1),
        save_path=str(args.checkpoint_dir),
        name_prefix=name_prefix,
    )
    callbacks = [checkpoint]
    if not args.no_early_stop:
        callbacks.append(
            BestAndEarlyStopCallback(
                args.checkpoint_dir,
                name_prefix,
                drop_below=3.0,
                patience_iters=5,
                min_iters_before_stop=8,
            )
        )
    callback = CallbackList(callbacks)

    if args.load:
        from stable_baselines3 import PPO
        from stable_baselines3.common.utils import FloatSchedule

        model = PPO.load(args.load, env=vector_env, device=args.device)
        # Loaded zips keep the original 3e-4 / 0.2 / 0.02 schedule, which walks a
        # good policy off its peak. Replace with a smaller constant fine-tune step.
        model.learning_rate = args.lr
        model.lr_schedule = FloatSchedule(args.lr)
        model.clip_range = FloatSchedule(args.clip_range)
        model.ent_coef = args.ent_coef
        # Only for old checkpoints that never saw slots 44–63. Skip after BC / later PPO.
        if args.zero_new_obs:
            import torch

            new_obs_start = 44
            with torch.no_grad():
                for net_name in ("policy_net", "value_net"):
                    first = getattr(model.policy.mlp_extractor, net_name)[0]
                    weight = first.weight
                    if weight.shape[1] > new_obs_start:
                        weight[:, new_obs_start:].zero_()
            print(
                f"Fine-tune lr={args.lr} clip_range={args.clip_range} "
                f"ent_coef={args.ent_coef}; zeroed obs cols {new_obs_start}+",
                file=sys.stderr,
            )
        else:
            print(
                f"Fine-tune lr={args.lr} clip_range={args.clip_range} "
                f"ent_coef={args.ent_coef}",
                file=sys.stderr,
            )
    else:
        model = build_ppo(vector_env, device=args.device)

    try:
        model.learn(
            total_timesteps=args.timesteps,
            callback=callback,
            progress_bar=False,
            tb_log_name=name_prefix,
        )
        model.save(final_path)
        print(f"Saved final policy to {final_path}.zip")
    except KeyboardInterrupt:
        model.save(final_path)
        print(f"Interrupted — saved current policy to {final_path}.zip")
    finally:
        try:
            vector_env.close()
        except (EOFError, ConnectionError, BrokenPipeError, OSError, KeyboardInterrupt):
            pass
        except Exception:
            pass


if __name__ == "__main__":
    main()

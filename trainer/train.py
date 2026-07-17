import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import SubprocVecEnv

from agents import build_ppo
from env import MinecraftEnv
from env.curriculum import stage_by_id

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_project_config() -> dict[str, Any]:
    path = PROJECT_ROOT / "config.json"
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def make_env(url: str, stage: int) -> Callable[[], Monitor]:
    def create() -> Monitor:
        return Monitor(MinecraftEnv(url=url, stage=stage))

    return create


def parse_args() -> argparse.Namespace:
    cfg = load_project_config()
    default_stage = int(cfg.get("stage", os.getenv("STAGE", "1")))
    default_envs = int(cfg.get("num_bots", os.getenv("NUM_ENVS", "3")))
    default_port = int(cfg.get("ws_base_port", os.getenv("WS_BASE_PORT", "8765")))
    default_steps = int(cfg.get("timesteps", 1_000_000))
    default_save = int(cfg.get("save_freq", 2000))

    parser = argparse.ArgumentParser(description="Train hierarchical Minecraft skill policies")
    parser.add_argument("--stage", type=int, default=default_stage, choices=range(9))
    parser.add_argument("--num-envs", type=int, default=default_envs)
    parser.add_argument("--base-port", type=int, default=default_port)
    parser.add_argument("--timesteps", type=int, default=default_steps)
    parser.add_argument("--save-freq", type=int, default=default_save)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--load", type=Path)
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
    vector_env = SubprocVecEnv([make_env(url, stage.id) for url in urls], start_method="spawn")
    args.checkpoint_dir.mkdir(parents=True, exist_ok=True)
    final_path = args.checkpoint_dir / f"stage_{stage.id}_{stage.name}_final"
    checkpoint = CheckpointCallback(
        save_freq=max(args.save_freq, 1),
        save_path=str(args.checkpoint_dir),
        name_prefix=f"stage_{stage.id}_{stage.name}",
    )
    if args.load:
        from stable_baselines3 import PPO

        model = PPO.load(args.load, env=vector_env, device=args.device)
    else:
        model = build_ppo(vector_env, device=args.device)

    try:
        model.learn(
            total_timesteps=args.timesteps,
            callback=checkpoint,
            progress_bar=False,
            tb_log_name=f"stage_{stage.id}_{stage.name}",
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

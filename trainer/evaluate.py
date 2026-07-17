import argparse
from pathlib import Path

from stable_baselines3 import PPO

from env import MinecraftEnv
from env.curriculum import STAGES


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a trained Minecraft policy")
    parser.add_argument("model", type=Path)
    parser.add_argument("--url", default="ws://127.0.0.1:8765")
    parser.add_argument("--stage", type=int, default=1, choices=range(len(STAGES)))
    parser.add_argument("--episodes", type=int, default=10)
    args = parser.parse_args()

    env = MinecraftEnv(url=args.url, stage=args.stage)
    model = PPO.load(args.model)
    returns: list[float] = []
    try:
        for episode in range(args.episodes):
            observation, _ = env.reset(seed=10_000 + episode)
            episode_return = 0.0
            terminated = truncated = False
            while not (terminated or truncated):
                action, _ = model.predict(observation, deterministic=True)
                observation, reward, terminated, truncated, info = env.step(int(action))
                episode_return += reward
            returns.append(episode_return)
            print(f"episode={episode} return={episode_return:.2f} milestones={info['milestones']}")
    finally:
        env.close()
    print(f"mean_return={sum(returns) / len(returns):.2f}")


if __name__ == "__main__":
    main()

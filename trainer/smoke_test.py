import argparse

from env import MinecraftEnv


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:8765")
    parser.add_argument("--steps", type=int, default=100)
    args = parser.parse_args()

    env = MinecraftEnv(url=args.url)
    try:
        observation, info = env.reset(seed=42)
        print(
            f"connected observation={observation.shape} "
            f"actions={info.get('actionSize')} "
            f"primitives={info.get('primitiveCount')} "
            f"invented={len(info.get('invented', []))}"
        )
        for step in range(args.steps):
            observation, reward, terminated, truncated, action_info = env.step(
                env.action_space.sample()
            )
            invented = action_info.get("inventedNow") or []
            print(
                f"step={step} action={action_info['action']} reward={reward:.3f} "
                f"done={terminated or truncated} invented_now={len(invented)}"
            )
            if terminated or truncated:
                observation, info = env.reset()
    finally:
        env.close()


if __name__ == "__main__":
    main()

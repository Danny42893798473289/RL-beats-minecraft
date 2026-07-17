from pathlib import Path

from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import VecEnv


def build_ppo(env: VecEnv, device: str = "auto", tensorboard_dir: str = "logs") -> PPO:
    Path(tensorboard_dir).mkdir(parents=True, exist_ok=True)
    # Compact policy + shorter rollouts: less RAM and faster iteration on CPU
    return PPO(
        policy="MlpPolicy",
        env=env,
        learning_rate=3e-4,
        n_steps=128,
        batch_size=64,
        n_epochs=3,
        gamma=0.99,
        gae_lambda=0.95,
        ent_coef=0.02,
        vf_coef=0.5,
        max_grad_norm=0.5,
        # Keep [128,128] so existing checkpoints still load
        policy_kwargs={"net_arch": {"pi": [128, 128], "vf": [128, 128]}},
        tensorboard_log=tensorboard_dir,
        device=device,
        verbose=1,
    )

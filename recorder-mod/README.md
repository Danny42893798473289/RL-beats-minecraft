# RL Demo Recorder (Fabric 1.21.4)

Client mod that records WASD / look / attack / use / inventory snapshots as JSONL for behavior cloning.

## Build

Needs **JDK 21**.

```bash
cd recorder-mod
./gradlew build
```

Jar: `build/libs/rl-demo-recorder-1.0.0.jar`

## Install

1. Install Fabric Loader for Minecraft **1.21.4** (PrismLauncher / official installer).
2. Install [Fabric API](https://modrinth.com/mod/fabric-api) for 1.21.4.
3. Copy `rl-demo-recorder-1.0.0.jar` into the instance `mods/` folder.

## Record

1. Join singleplayer or your Paper world.
2. Optional: `/rlstage 6` (or whatever curriculum stage you’re demonstrating).
3. Press **R** (or `/rlrec start`) and play the goal (e.g. craft a furnace).
4. Press **R** again (or `/rlrec stop`).
5. Demos land in `.minecraft/rl-demos/demo_YYYYMMDD_HHMMSS.jsonl`.

Copy JSONL files into the repo `demos/` folder, then:

```bash
cd trainer
uv run python bc_train.py --demos ../demos --out ../checkpoints/stage_6_bc.zip --stage 6
uv run python train.py --stage 6 --load ../checkpoints/stage_6_bc.zip
```

## JSONL fields

Each line: `t`, `stage_hint`, `keys` (forward/back/left/right/jump/sneak/sprint/attack/use/…), `look` (yaw/pitch/dyaw/dpitch), `hotbar`, `pos`, `inv` (tracked item counts), `health`, `food`, `dimension`, `screen`.

# Minecraft HRL Bot

A multi-instance hierarchical reinforcement-learning system targeting Minecraft Java 1.21.4.
Mineflayer executes structured skills while PPO learns which skill to choose from compact game-state
observations. The curriculum grows from gathering wood toward defeating the Ender Dragon.

## Current state

Implemented:

- Isolated Paper 1.21.4 + Mineflayer environment pairs
- WebSocket `reset` / `step` protocol with RCON episode resets
- Learnable **primitive** actions (move, look, dig, craft, attack, …)
- **Skill invention**: successful primitive sequences that unlock milestones are saved as new
  reusable actions in inventable slots
- Fixed 64-value observations and shaped milestone rewards
- Gymnasium environment, vectorized PPO trainer, checkpoints, TensorBoard, and evaluation
- Configurable parallelism; three workers by default on 16GB-friendly settings
- Live **web dashboard** (`http://127.0.0.1:8080`) with per-bot inventory and first-person view

The Nether, stronghold, and dragon stages are represented in the curriculum but need more
primitives and training time. This project is a training framework, not a pretrained dragon-killing
model.

## Requirements

- Java 21
- Node.js 22+
- Python 3.11–3.13 and [uv](https://docs.astral.sh/uv/)
- At least ~8 GB RAM for the default shared setup (1 Paper ~4G + 10 bots)
- Docker is optional

## Config

Edit project-root [`config.json`](config.json). Defaults match a 10-bot shared-server run:

- `shared_server: true` — one Paper; bots teleported ~`pad_spacing` (1000) blocks apart
- `num_bots: 10`, `wipe_every_episodes: 25`, `stage: 2` (crafting_table), viewers on

## Native setup

```bash
./scripts/bootstrap.sh
./scripts/start_local.sh          # reads config.json
```

Open the live dashboard: [http://127.0.0.1:8080](http://127.0.0.1:8080)

Overrides still work: `--NUM_ENVS=4`, `ENABLE_VIEWER=0`, `--SHARED_SERVER=0` (isolated Paper per bot).

In a second terminal:

```bash
cd trainer
uv run python train.py --stage 3 --load ../checkpoints/stage_3_wooden_pickaxe_final.zip
```

`train.py` reads `num_bots` / `stage` / `timesteps` from `config.json` when flags are omitted.
With `"stage": 2` this trains the **crafting_table** goal; use `--stage 3` with
`stage_3_wooden_pickaxe_final.zip` to continue wooden-pickaxe training.

Ports (shared mode):

- Minecraft / RCON: `25565` / `25575` (one server)
- WebSocket bridge: `8765 + rank`
- Viewer / status: `3000 + rank` / `8865 + rank`

## Docker setup

Generate as many isolated worker pairs as needed, then launch them:

```bash
python3 scripts/generate_compose.py 8
docker compose up --build -d
cd trainer
uv run python train.py --stage 1 --num-envs 8
```

Do not run the trainer container from the generated Compose file; running the trainer on the host
keeps checkpoints and GPU access straightforward.

## Curriculum

Twenty fine-grained stages, each a short goal you train sequentially with `--load` from the
previous stage's checkpoint. Each stage has its own episode-step budget (short for early goals,
longer for the nether/end).

| Stage | Name | Wins when it gets | Ep steps |
|------:|------|-------------------|---------:|
| 0 | `log` | any log | 256 |
| 1 | `planks` | planks | 256 |
| 2 | `crafting_table` | crafting table *(default `stage`)* | 256 |
| 3 | `wooden_pickaxe` | wooden pickaxe | 384 |
| 4 | `cobblestone` | cobblestone | 384 |
| 5 | `stone_pickaxe` | stone pickaxe | 384 |
| 6 | `furnace` | furnace | 384 |
| 7 | `raw_iron` | raw iron | 512 |
| 8 | `iron_ingot` | iron ingot *(smelt)* | 512 |
| 9 | `iron_pickaxe` | iron pickaxe | 512 |
| 10 | `diamond` | diamond | 768 |
| 11 | `diamond_pickaxe` | diamond pickaxe | 768 |
| 12 | `obsidian` | obsidian *(mine with diamond pick)* | 768 |
| 13 | `flint_and_steel` | flint & steel | 512 |
| 14 | `nether` | enter the Nether | 768 |
| 15 | `blaze_rod` | blaze rod | 1024 |
| 16 | `ender_pearl` | ender pearl | 1024 |
| 17 | `ender_eye` | eye of ender | 768 |
| 18 | `end` | enter the End | 1536 |
| 19 | `dragon_killed` | Ender Dragon killed | 2048 |

> Remapping note: this replaces the old 9-stage curriculum. The wooden pickaxe is now **stage 3**
> (was 2); `config.json` `"stage": 2` now means **crafting_table**. Old checkpoints
> (`stage_1_wood_final.zip`, `stage_3_wooden_pickaxe_final.zip`) still load — obs/action sizes are
> unchanged — just pass them via `--load`.

Train each stage from the previous checkpoint, e.g.:

```bash
uv run python train.py --stage 3 --load ../checkpoints/stage_2_crafting_table_final.zip
uv run python train.py --stage 5 --load ../checkpoints/stage_4_cobblestone_final.zip
uv run python train.py --stage 9 --load ../checkpoints/stage_8_iron_ingot_final.zip
```

Stages 12–19 (obsidian → dragon) have the skills wired but need substantial training time.

```bash
uv run python evaluate.py ../checkpoints/stage_1_wood_final.zip --stage 1
```

Monitor training:

```bash
uv run tensorboard --logdir logs
```

List skills the bot invented from successful sequences:

```bash
python3 ../scripts/list_invented_skills.py
```

Invented skills are stored in `runtime/invented_skills.json` and reused as single actions
(`INVENTED_*` slots) once discovered.

## How learning invents actions

1. The policy chooses among **primitives** (forward, dig looking, craft next, …).
2. Recent successful primitive steps are traced each episode.
3. When a milestone flips (first log, crafting table, wooden pickaxe, …), that trace is compressed
   into a new named skill and written to disk.
4. Later episodes can call the invented skill as one action, so the agent reuses what it discovered.

## Protocol

Each bridge accepts JSON over WebSocket:

- `{"id":"1","type":"ping"}`
- `{"id":"2","type":"reset","stage":1}`
- `{"id":"3","type":"step","action":2}`

Responses echo `id` and include observations, reward, termination flags, and milestones. This keeps
the Node game-control process independent from the Python learning process.

## Important limitations

Pure reinforcement learning from a new random policy will take substantial compute and will not
quickly beat the game. High-level Mineflayer skills make the problem far more tractable than
pixel/keyboard RL, but the late-game stages still require additional navigation, portal, brewing,
combat, and dragon-fight options plus extensive training.

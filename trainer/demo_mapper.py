"""Map Fabric demo JSONL ticks to discrete Mineflayer skill action ids."""
from __future__ import annotations

from typing import Any

# Must match bridge/src/skills.js PRIMITIVES order.
PRIMITIVES = [
    "WAIT",
    "FORWARD",
    "BACK",
    "STRAFE_LEFT",
    "STRAFE_RIGHT",
    "TURN_LEFT",
    "TURN_RIGHT",
    "LOOK_UP",
    "LOOK_DOWN",
    "JUMP",
    "DIG_LOOKING",
    "PLACE_HELD",
    "ATTACK",
    "USE_ITEM",
    "EAT",
    "SWAP_HOTBAR",
    "DROP_HELD",
    "CRAFT_NEXT",
    "EQUIP_BEST_TOOL",
    "PATH_TO_LOOK",
]

ACTION_NAME_TO_ID = {name: i for i, name in enumerate(PRIMITIVES)}
ACTION_SIZE = 52  # primitives + invented slots (BC only labels primitives)

TRACKED_ITEMS = [
    "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
    "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log",
    "oak_planks", "crafting_table", "wooden_pickaxe", "cobblestone",
    "stone_pickaxe", "furnace", "raw_iron", "iron_ingot", "iron_pickaxe",
    "diamond", "diamond_pickaxe", "obsidian", "flint_and_steel",
    "blaze_rod", "ender_pearl", "ender_eye",
]

OBSERVATION_SIZE = 64
MAX_STAGE = 19


def _truthy(keys: dict[str, Any], name: str) -> bool:
    return bool(keys.get(name))


def map_action(row: dict[str, Any]) -> int:
    """Heuristic: raw client keys/look → nearest primitive action id."""
    keys = row.get("keys") or {}
    look = row.get("look") or {}
    screen = row.get("screen")

    in_craft_screen = bool(
        screen and any(token in screen for token in ("Crafting", "RecipeBook", "InventoryScreen"))
    )

    dyaw = float(look.get("dyaw") or 0.0)
    dpitch = float(look.get("dpitch") or 0.0)

    if _truthy(keys, "attack"):
        # Breaking blocks vs hitting mobs — DIG covers both for BC warm-start.
        return ACTION_NAME_TO_ID["DIG_LOOKING"]
    if _truthy(keys, "use"):
        if in_craft_screen:
            return ACTION_NAME_TO_ID["CRAFT_NEXT"]
        return ACTION_NAME_TO_ID["PLACE_HELD"]
    if _truthy(keys, "drop"):
        return ACTION_NAME_TO_ID["DROP_HELD"]
    if in_craft_screen:
        return ACTION_NAME_TO_ID["CRAFT_NEXT"]

    # Look turns before translation so demos that aim still label look actions.
    if abs(dyaw) >= 4.0 and abs(dyaw) >= abs(dpitch):
        return ACTION_NAME_TO_ID["TURN_LEFT" if dyaw < 0 else "TURN_RIGHT"]
    if abs(dpitch) >= 3.0:
        return ACTION_NAME_TO_ID["LOOK_UP" if dpitch < 0 else "LOOK_DOWN"]

    if _truthy(keys, "jump"):
        return ACTION_NAME_TO_ID["JUMP"]
    if _truthy(keys, "forward"):
        return ACTION_NAME_TO_ID["FORWARD"]
    if _truthy(keys, "back"):
        return ACTION_NAME_TO_ID["BACK"]
    if _truthy(keys, "left"):
        return ACTION_NAME_TO_ID["STRAFE_LEFT"]
    if _truthy(keys, "right"):
        return ACTION_NAME_TO_ID["STRAFE_RIGHT"]

    return ACTION_NAME_TO_ID["WAIT"]


def build_observation(row: dict[str, Any], stage: int | None = None) -> list[float]:
    """Approximate bridge snapshot() from demo JSONL fields."""
    inv = row.get("inv") or {}
    look = row.get("look") or {}
    pos = row.get("pos") or {}
    stage_val = int(stage if stage is not None else row.get("stage_hint") or 0)
    stage_val = max(0, min(MAX_STAGE, stage_val))

    yaw = float(look.get("yaw") or 0.0)
    # Minecraft yaw degrees → [0,1) like bridge (radians / 2pi). Approx: wrap degrees/360.
    yaw_n = ((yaw % 360.0) + 360.0) % 360.0 / 360.0
    pitch = float(look.get("pitch") or 0.0)
    pitch_n = (pitch + 90.0) / 180.0  # rough normalize
    pitch_n = max(0.0, min(1.0, pitch_n))

    y = float(pos.get("y") or 64.0)
    health = float(row.get("health") or 20.0) / 20.0
    food = float(row.get("food") or 20.0) / 20.0
    dim = str(row.get("dimension") or "")
    nether = 1.0 if "nether" in dim else 0.0
    end = 1.0 if dim.endswith("the_end") or dim.endswith(":the_end") else 0.0

    values: list[float] = [
        max(0.0, min(1.0, health)),
        max(0.0, min(1.0, food)),
        max(0.0, min(1.0, max(-64.0, min(320.0, y)) / 320.0)),
        0.5,  # time of day unknown
        0.0,  # sleeping
        nether,
        end,
        stage_val / MAX_STAGE,
        yaw_n,
        pitch_n,
        0.0,  # inventedCount
    ]

    for name in TRACKED_ITEMS:
        values.append(min(float(inv.get(name) or 0), 64.0) / 64.0)

    # nearby mobs/players/dig/held/dragon/explore flags unknown → zeros + held proxy
    values.extend([
        0.0, 0.0,
        1.0 if (row.get("keys") or {}).get("attack") else 0.0,
        1.0 if any(float(inv.get(k) or 0) > 0 for k in ("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe")) else 0.0,
        0.0, 0.0, 0.0, 0.0,
    ])

    while len(values) < OBSERVATION_SIZE:
        values.append(0.0)
    return values[:OBSERVATION_SIZE]

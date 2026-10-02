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
# Must match bridge/src/observations.js NEW_OBS_START (legacy 44 + craft/hazard bits).
NEW_OBS_START = 44
MAX_STAGE = 19


def _truthy(keys: dict[str, Any], name: str) -> bool:
    return bool(keys.get(name))


def _inv_count(row: dict[str, Any], name: str) -> int:
    inv = row.get("inv") or {}
    try:
        return int(inv.get(name) or 0)
    except (TypeError, ValueError):
        return 0


def _in_craft_screen(screen: Any) -> bool:
    """Fabric releases often expose intermediary simple names like class_479."""
    if not screen:
        return False
    s = str(screen)
    if any(token in s for token in ("Crafting", "RecipeBook", "InventoryScreen", "Furnace", "Smoker", "Blast")):
        return True
    # Known intermediary / obfuscated crafting UI class names seen in demos.
    if s.startswith("class_"):
        return True
    return False


def map_action(row: dict[str, Any], prev: dict[str, Any] | None = None) -> int:
    """Heuristic: raw client keys/look/inv deltas → nearest primitive action id."""
    keys = row.get("keys") or {}
    look = row.get("look") or {}
    screen = row.get("screen")
    in_craft_screen = _in_craft_screen(screen)

    # Inventory outcomes beat key heuristics (mouse crafting rarely holds attack/use).
    if prev is not None:
        if _inv_count(row, "furnace") > _inv_count(prev, "furnace"):
            return ACTION_NAME_TO_ID["CRAFT_NEXT"]
        if _inv_count(row, "stone_pickaxe") > _inv_count(prev, "stone_pickaxe"):
            return ACTION_NAME_TO_ID["CRAFT_NEXT"]
        if _inv_count(row, "crafting_table") < _inv_count(prev, "crafting_table"):
            return ACTION_NAME_TO_ID["PLACE_HELD"]
        crafted_up = any(
            _inv_count(row, name) > _inv_count(prev, name)
            for name in ("wooden_pickaxe", "iron_pickaxe", "diamond_pickaxe", "oak_planks", "stick")
        )
        if crafted_up and in_craft_screen:
            return ACTION_NAME_TO_ID["CRAFT_NEXT"]

    dyaw = float(look.get("dyaw") or 0.0)
    dpitch = float(look.get("dpitch") or 0.0)

    if _truthy(keys, "attack"):
        return ACTION_NAME_TO_ID["DIG_LOOKING"]
    if _truthy(keys, "use"):
        if in_craft_screen:
            return ACTION_NAME_TO_ID["CRAFT_NEXT"]
        return ACTION_NAME_TO_ID["PLACE_HELD"]
    if _truthy(keys, "drop"):
        return ACTION_NAME_TO_ID["DROP_HELD"]
    if in_craft_screen:
        return ACTION_NAME_TO_ID["CRAFT_NEXT"]

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

    # Slots 44–63: same order as bridge snapshot() craft-ready / look-at / hostile bits.
    # Human demos lack look-at / light / hostile fields → leave those at 0.
    sticks = float(inv.get("stick") or 0)
    total_planks = sum(
        float(count or 0) for name, count in inv.items() if str(name).endswith("_planks")
    )
    cobble = float(inv.get("cobblestone") or 0) + float(inv.get("cobbled_deepslate") or 0)
    values.extend([
        min(sticks, 64.0) / 64.0,
        min(total_planks, 64.0) / 64.0,
        0.0,  # table nearby unknown
        1.0 if float(inv.get("wooden_pickaxe") or 0) > 0 else 0.0,
        1.0 if cobble >= 8 else 0.0,
        0.0,  # look stone
        0.0,  # look log
        0.0,  # look hazard
        0.0,  # light
        0.0,  # hostile present
        0.5,  # hostile dx neutral
        0.5,  # hostile dz neutral
    ])

    while len(values) < OBSERVATION_SIZE:
        values.append(0.0)
    return values[:OBSERVATION_SIZE]

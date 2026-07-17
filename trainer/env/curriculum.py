from dataclasses import dataclass


@dataclass(frozen=True)
class Stage:
    id: int
    name: str
    success_milestone: str
    episode_steps: int


STAGES = (
    Stage(0, "log", "log", 256),
    Stage(1, "planks", "planks", 256),
    Stage(2, "crafting_table", "crafting_table", 256),
    Stage(3, "wooden_pickaxe", "wooden_pickaxe", 384),
    Stage(4, "cobblestone", "cobblestone", 384),
    Stage(5, "stone_pickaxe", "stone_pickaxe", 384),
    Stage(6, "furnace", "furnace", 384),
    Stage(7, "raw_iron", "raw_iron", 512),
    Stage(8, "iron_ingot", "iron_ingot", 512),
    Stage(9, "iron_pickaxe", "iron_pickaxe", 512),
    Stage(10, "diamond", "diamond", 768),
    Stage(11, "diamond_pickaxe", "diamond_pickaxe", 768),
    Stage(12, "obsidian", "obsidian", 768),
    Stage(13, "flint_and_steel", "flint_and_steel", 512),
    Stage(14, "nether", "nether", 768),
    Stage(15, "blaze_rod", "blaze_rod", 1024),
    Stage(16, "ender_pearl", "ender_pearl", 1024),
    Stage(17, "ender_eye", "ender_eye", 768),
    Stage(18, "end", "end", 1536),
    Stage(19, "dragon_killed", "dragon_killed", 2048),
)


def stage_by_id(stage_id: int) -> Stage:
    if not 0 <= stage_id < len(STAGES):
        raise ValueError(f"stage must be between 0 and {len(STAGES) - 1}")
    return STAGES[stage_id]

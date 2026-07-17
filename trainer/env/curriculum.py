from dataclasses import dataclass


@dataclass(frozen=True)
class Stage:
    id: int
    name: str
    success_milestone: str
    episode_steps: int


STAGES = (
    Stage(0, "survival_boot", "log", 256),
    Stage(1, "wood", "crafting_table", 256),
    Stage(2, "wooden_tools", "wooden_pickaxe", 384),
    Stage(3, "stone", "stone_pickaxe", 512),
    Stage(4, "iron", "iron_pickaxe", 1024),
    Stage(5, "diamond", "diamond_pickaxe", 1536),
    Stage(6, "nether", "blaze_rod", 2048),
    Stage(7, "eyes_and_stronghold", "ender_eye", 3072),
    Stage(8, "the_end", "dragon_killed", 4096),
)


def stage_by_id(stage_id: int) -> Stage:
    if not 0 <= stage_id < len(STAGES):
        raise ValueError(f"stage must be between 0 and {len(STAGES) - 1}")
    return STAGES[stage_id]

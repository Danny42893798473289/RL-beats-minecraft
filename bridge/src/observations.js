const TRACKED_ITEMS = [
  "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
  "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log",
  "oak_planks", "crafting_table", "wooden_pickaxe", "cobblestone",
  "stone_pickaxe", "furnace", "raw_iron", "iron_ingot", "iron_pickaxe",
  "diamond", "diamond_pickaxe", "obsidian", "flint_and_steel",
  "blaze_rod", "ender_pearl", "ender_eye"
];

/** Biomes that rarely/never have trees — explore to find wood. */
const TREELESS_BIOMES = new Set([
  "desert", "desert_hills", "desert_lakes",
  "beach", "snowy_beach", "stony_shore",
  "ocean", "deep_ocean", "warm_ocean", "lukewarm_ocean", "cold_ocean", "frozen_ocean",
  "deep_warm_ocean", "deep_lukewarm_ocean", "deep_cold_ocean", "deep_frozen_ocean",
  "river", "frozen_river",
  "badlands", "eroded_badlands",
  "ice_spikes", "snowy_plains", "ice_plains",
  "mushroom_fields", "mushroom_field_shore",
  "stony_peaks", "jagged_peaks", "frozen_peaks",
  "dripstone_caves", "deep_dark",
  "nether_wastes", "soul_sand_valley", "basalt_deltas", "crimson_forest", "warped_forest"
]);

const LOG_BLOCK_NAMES = [
  "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
  "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"
];

export const OBSERVATION_SIZE = 64;

function countItems(bot) {
  const counts = new Map();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return counts;
}

function biomeName(bot) {
  try {
    const block = bot.blockAt(bot.entity?.position);
    return block?.biome?.name ?? "";
  } catch {
    return "";
  }
}

function logsNearby(bot, maxDistance = 32) {
  try {
    const ids = LOG_BLOCK_NAMES
      .map((name) => bot.registry?.blocksByName?.[name]?.id)
      .filter((id) => id != null);
    if (!ids.length) return false;
    return Boolean(bot.findBlock({ matching: ids, maxDistance }));
  } catch {
    return false;
  }
}

/**
 * True when the bot should leave this area to find trees
 * (desert / ocean / badlands / etc., or no logs in sight).
 */
export function needsWoodExplore(bot) {
  const name = biomeName(bot);
  const treeless = TREELESS_BIOMES.has(name)
    || name.includes("desert")
    || (name.includes("ocean") && !name.includes("forest"))
    || (name.includes("badlands") && !name.includes("wooded"));
  const nearby = logsNearby(bot, 28);
  return {
    biome: name,
    treelessBiome: treeless,
    logsNearby: nearby,
    needsExplore: treeless || !nearby
  };
}

export const MAX_STAGE = 19;

export function snapshot(bot, stage = 1, inventedCount = 0, maxInvented = 32, extra = {}) {
  const counts = countItems(bot);
  const pos = bot.entity?.position;
  const yaw = ((bot.entity?.yaw ?? 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const explore = needsWoodExplore(bot);
  const values = [
    (bot.health ?? 20) / 20,
    (bot.food ?? 20) / 20,
    Math.max(-64, Math.min(320, pos?.y ?? 64)) / 320,
    ((bot.time?.timeOfDay ?? 0) % 24000) / 24000,
    bot.isSleeping ? 1 : 0,
    ["the_nether", "minecraft:the_nether"].includes(bot.game?.dimension) ? 1 : 0,
    ["the_end", "minecraft:the_end"].includes(bot.game?.dimension) ? 1 : 0,
    Math.min(stage, MAX_STAGE) / MAX_STAGE,
    yaw / (Math.PI * 2),
    ((bot.entity?.pitch ?? 0) + 1.2) / 2.4,
    Math.min(inventedCount, maxInvented) / maxInvented
  ];

  for (const name of TRACKED_ITEMS) {
    values.push(Math.min(counts.get(name) ?? 0, 64) / 64);
  }

  const nearby = Object.values(bot.entities ?? {});
  values.push(
    Math.min(nearby.filter((e) => e.type === "mob").length, 16) / 16,
    Math.min(nearby.filter((e) => e.type === "player").length, 8) / 8,
    bot.targetDigBlock ? 1 : 0,
    bot.heldItem ? 1 : 0,
    extra.dragon_killed ? 1 : 0,
    explore.treelessBiome ? 1 : 0,
    explore.logsNearby ? 1 : 0,
    explore.needsExplore ? 1 : 0
  );

  while (values.length < OBSERVATION_SIZE) values.push(0);
  return values.slice(0, OBSERVATION_SIZE);
}

export function milestoneState(bot, extra = {}) {
  const counts = countItems(bot);
  const hasAny = (...names) => names.some((name) => (counts.get(name) ?? 0) > 0);
  const tableNearby = Boolean(bot.findBlock?.({
    matching: bot.registry?.blocksByName?.crafting_table?.id,
    maxDistance: 16
  }));
  const furnaceNearby = Boolean(bot.findBlock?.({
    matching: bot.registry?.blocksByName?.furnace?.id,
    maxDistance: 16
  }));
  const obsidianNearby = Boolean(bot.findBlock?.({
    matching: bot.registry?.blocksByName?.obsidian?.id,
    maxDistance: 8
  }));
  return {
    log: hasAny("oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"),
    planks: [...counts.keys()].some((name) => name.endsWith("_planks") && counts.get(name) > 0),
    // Inventory OR placed nearby counts (crafting/progress detection)
    crafting_table: hasAny("crafting_table") || tableNearby,
    wooden_pickaxe: hasAny("wooden_pickaxe"),
    cobblestone: hasAny("cobblestone"),
    stone_pickaxe: hasAny("stone_pickaxe"),
    furnace: hasAny("furnace") || furnaceNearby,
    raw_iron: hasAny("raw_iron"),
    iron_ingot: hasAny("iron_ingot"),
    iron_pickaxe: hasAny("iron_pickaxe"),
    diamond: hasAny("diamond"),
    diamond_pickaxe: hasAny("diamond_pickaxe"),
    obsidian: hasAny("obsidian") || obsidianNearby,
    flint_and_steel: hasAny("flint_and_steel"),
    nether: ["the_nether", "minecraft:the_nether"].includes(bot.game?.dimension),
    blaze_rod: hasAny("blaze_rod"),
    ender_pearl: hasAny("ender_pearl"),
    ender_eye: hasAny("ender_eye"),
    end: ["the_end", "minecraft:the_end"].includes(bot.game?.dimension),
    dragon_killed: Boolean(extra.dragon_killed)
  };
}

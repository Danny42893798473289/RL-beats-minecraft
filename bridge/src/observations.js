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

const STONE_LOOK_NAMES = new Set([
  "stone", "cobblestone", "cobbled_deepslate", "deepslate",
  "granite", "diorite", "andesite", "tuff", "blackstone"
]);

const PASSIVE_MOBS = new Set([
  "cow", "pig", "sheep", "chicken", "rabbit", "horse", "donkey", "mule",
  "llama", "trader_llama", "cat", "wolf", "parrot", "ocelot", "fox",
  "bee", "turtle", "panda", "polar_bear", "goat", "axolotl", "frog",
  "tadpole", "camel", "sniffer", "allay", "villager", "wandering_trader",
  "iron_golem", "snow_golem", "bat", "squid", "glow_squid", "dolphin",
  "cod", "salmon", "tropical_fish", "pufferfish", "mooshroom", "strider"
]);

/** First unused slot after the legacy 44-dim observation. Keep size 64. */
export const NEW_OBS_START = 44;
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

function isLavaName(name) {
  return name === "lava" || name === "flowing_lava";
}

function isAirName(name) {
  return !name || name === "air" || name === "cave_air" || name === "void_air";
}

/** True when digging this block would open lava or a drop of more than 3. */
function isHazardBlock(bot, block) {
  if (!block) return false;
  if (isLavaName(block.name)) return true;
  for (let dy = 1; dy <= 4; dy += 1) {
    const below = bot.blockAt?.(block.position.offset(0, -dy, 0));
    if (!below || isAirName(below.name)) {
      if (dy > 3) return true;
      continue;
    }
    if (isLavaName(below.name)) return true;
    break;
  }
  return false;
}

function lookAtFlags(bot) {
  let cursor = null;
  try {
    cursor = bot.blockAtCursor?.(5) ?? null;
  } catch {
    cursor = null;
  }
  const name = cursor?.name ?? "";
  return {
    stone: STONE_LOOK_NAMES.has(name) ? 1 : 0,
    log: LOG_BLOCK_NAMES.includes(name) ? 1 : 0,
    hazard: isHazardBlock(bot, cursor) ? 1 : 0
  };
}

function lightLevel(bot) {
  try {
    const block = bot.blockAt(bot.entity?.position);
    const light = block?.light ?? block?.skyLight ?? 15;
    return Math.max(0, Math.min(15, Number(light) || 0)) / 15;
  } catch {
    return 1;
  }
}

function nearestHostileDirection(bot) {
  const me = bot.entity?.position;
  if (!me) return { present: 0, dx: 0.5, dz: 0.5 };
  let best = null;
  let bestDist = 16;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity === bot.entity) continue;
    if (entity.type === "player") {
      const uname = entity.username || entity.name || "";
      if (/^rl_bot_\d+$/i.test(uname)) continue;
    } else if (entity.type !== "mob" && entity.type !== "hostile") {
      continue;
    } else {
      const name = entity.name || entity.displayName || "";
      if (PASSIVE_MOBS.has(name)) continue;
    }
    const dist = entity.position.distanceTo(me);
    if (dist > bestDist) continue;
    bestDist = dist;
    best = entity;
  }
  if (!best) return { present: 0, dx: 0.5, dz: 0.5 };
  const rawDx = best.position.x - me.x;
  const rawDz = best.position.z - me.z;
  const horiz = Math.hypot(rawDx, rawDz) || 1;
  // Map [-1, 1] → [0, 1] for the Box observation space.
  return {
    present: 1,
    dx: 0.5 + 0.5 * (rawDx / horiz),
    dz: 0.5 + 0.5 * (rawDz / horiz)
  };
}

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

  // Slots 44–63: craft-ready + look-at + light + hostile direction.
  const sticks = counts.get("stick") ?? 0;
  let totalPlanks = 0;
  for (const [name, count] of counts) {
    if (name.endsWith("_planks")) totalPlanks += count;
  }
  const cobble = (counts.get("cobblestone") ?? 0) + (counts.get("cobbled_deepslate") ?? 0);
  const tableNearby = Boolean(bot.findBlock?.({
    matching: bot.registry?.blocksByName?.crafting_table?.id,
    maxDistance: 16
  }));
  const look = lookAtFlags(bot);
  const threat = nearestHostileDirection(bot);
  values.push(
    Math.min(sticks, 64) / 64,
    Math.min(totalPlanks, 64) / 64,
    tableNearby ? 1 : 0,
    (counts.get("wooden_pickaxe") ?? 0) > 0 ? 1 : 0,
    cobble >= 8 ? 1 : 0,
    look.stone,
    look.log,
    look.hazard,
    lightLevel(bot),
    threat.present,
    threat.dx,
    threat.dz
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

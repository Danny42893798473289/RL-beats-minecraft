const TRACKED_ITEMS = [
  "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
  "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log",
  "oak_planks", "crafting_table", "wooden_pickaxe", "cobblestone",
  "stone_pickaxe", "furnace", "raw_iron", "iron_ingot", "iron_pickaxe",
  "diamond", "diamond_pickaxe", "obsidian", "flint_and_steel",
  "blaze_rod", "ender_pearl", "ender_eye"
];

export const OBSERVATION_SIZE = 64;

function countItems(bot) {
  const counts = new Map();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return counts;
}

export function snapshot(bot, stage = 1, inventedCount = 0, maxInvented = 32) {
  const counts = countItems(bot);
  const pos = bot.entity?.position;
  const yaw = ((bot.entity?.yaw ?? 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const values = [
    (bot.health ?? 20) / 20,
    (bot.food ?? 20) / 20,
    Math.max(-64, Math.min(320, pos?.y ?? 64)) / 320,
    ((bot.time?.timeOfDay ?? 0) % 24000) / 24000,
    bot.isSleeping ? 1 : 0,
    ["the_nether", "minecraft:the_nether"].includes(bot.game?.dimension) ? 1 : 0,
    ["the_end", "minecraft:the_end"].includes(bot.game?.dimension) ? 1 : 0,
    Math.min(stage, 8) / 8,
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
    bot.heldItem ? 1 : 0
  );

  while (values.length < OBSERVATION_SIZE) values.push(0);
  return values.slice(0, OBSERVATION_SIZE);
}

export function milestoneState(bot) {
  const counts = countItems(bot);
  const hasAny = (...names) => names.some((name) => (counts.get(name) ?? 0) > 0);
  const tableNearby = Boolean(bot.findBlock?.({
    matching: bot.registry?.blocksByName?.crafting_table?.id,
    maxDistance: 16
  }));
  return {
    log: hasAny("oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"),
    planks: [...counts.keys()].some((name) => name.endsWith("_planks") && counts.get(name) > 0),
    // Inventory OR placed nearby counts (stage 1 / craft progress)
    crafting_table: hasAny("crafting_table") || tableNearby,
    wooden_pickaxe: hasAny("wooden_pickaxe"),
    cobblestone: hasAny("cobblestone"),
    stone_pickaxe: hasAny("stone_pickaxe"),
    furnace: hasAny("furnace"),
    raw_iron: hasAny("raw_iron"),
    iron_ingot: hasAny("iron_ingot"),
    iron_pickaxe: hasAny("iron_pickaxe"),
    diamond: hasAny("diamond"),
    diamond_pickaxe: hasAny("diamond_pickaxe"),
    nether: ["the_nether", "minecraft:the_nether"].includes(bot.game?.dimension),
    blaze_rod: hasAny("blaze_rod"),
    ender_eye: hasAny("ender_eye"),
    end: ["the_end", "minecraft:the_end"].includes(bot.game?.dimension)
  };
}

import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

const { goals } = pathfinderPkg;

const LOGS = [
  "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
  "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"
];

const CRAFT_TARGETS = [
  "oak_planks", "birch_planks", "spruce_planks",
  "crafting_table", "wooden_pickaxe", "stick",
  "wooden_axe", "wooden_sword",
  "stone_pickaxe", "furnace", "torch",
  "iron_ingot", "iron_pickaxe", "iron_sword",
  "diamond_pickaxe", "shield"
];

/** Atomic actions the policy invents behavior from. */
export const PRIMITIVES = [
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
  "PATH_TO_LOOK"
];

export const MAX_INVENTED = 32;
export const ACTION_SIZE = PRIMITIVES.length + MAX_INVENTED;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clearControl(bot) {
  bot.clearControlStates();
}

async function hold(bot, control, ms) {
  bot.setControlState(control, true);
  await sleep(ms);
  bot.setControlState(control, false);
}

const MOVE_MS = Number(process.env.MOVE_MS ?? 70);
const WAIT_MS = Number(process.env.WAIT_MS ?? 20);
const COLLECT_BUDGET_MS = Number(process.env.COLLECT_BUDGET_MS ?? 900);
const PATH_TIMEOUT_MS = Number(process.env.PATH_TIMEOUT_MS ?? 1200);

/** Minimum pickaxe tier required to get drops: 1 wood, 2 stone, 3 iron, 4 diamond */
const BLOCK_TIER = {
  stone: 1, cobblestone: 1, granite: 1, diorite: 1, andesite: 1,
  deepslate: 1, cobbled_deepslate: 1, tuff: 1,
  coal_ore: 1, deepslate_coal_ore: 1,
  copper_ore: 1, deepslate_copper_ore: 1,
  iron_ore: 2, deepslate_iron_ore: 2,
  gold_ore: 3, deepslate_gold_ore: 3,
  redstone_ore: 3, deepslate_redstone_ore: 3,
  diamond_ore: 3, deepslate_diamond_ore: 3,
  emerald_ore: 3, deepslate_emerald_ore: 3,
  lapis_ore: 2, deepslate_lapis_ore: 2,
  obsidian: 4, ancient_debris: 4
};

const IRON_ORES = ["iron_ore", "deepslate_iron_ore"];
const DIAMOND_ORES = ["diamond_ore", "deepslate_diamond_ore"];
const COAL_ORES = ["coal_ore", "deepslate_coal_ore"];
const STONE_BLOCKS = ["stone", "cobblestone", "deepslate", "cobbled_deepslate", "granite", "diorite", "andesite"];

function pickaxeTier(bot) {
  let best = 0;
  for (const item of bot.inventory.items()) {
    if (!item.name.includes("pickaxe")) continue;
    if (item.name.startsWith("netherite_") || item.name.startsWith("diamond_")) best = Math.max(best, 4);
    else if (item.name.startsWith("iron_")) best = Math.max(best, 3);
    else if (item.name.startsWith("stone_")) best = Math.max(best, 2);
    else if (item.name.startsWith("wooden_") || item.name.startsWith("golden_")) best = Math.max(best, 1);
  }
  return best;
}

function hasPickaxe(bot) {
  return pickaxeTier(bot) > 0;
}

function canMineBlock(bot, blockName) {
  const need = BLOCK_TIER[blockName];
  if (need == null) return true;
  return pickaxeTier(bot) >= need;
}

function countName(bot, name) {
  return bot.inventory.items()
    .filter((item) => item.name === name)
    .reduce((n, item) => n + item.count, 0);
}

function findFuel(bot) {
  const fuelOrder = [
    "coal", "charcoal", "coal_block",
    "oak_planks", "birch_planks", "spruce_planks", "jungle_planks",
    "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks",
    "oak_log", "birch_log", "spruce_log", "stick"
  ];
  for (const name of fuelOrder) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (item) return item;
  }
  return null;
}

function nearestDrop(bot, maxDistance = 16) {
  return bot.nearestEntity((entity) => {
    if (!entity || entity.name !== "item") return false;
    return entity.position.distanceTo(bot.entity.position) <= maxDistance;
  });
}

async function collectNearbyDrops(bot, { maxDistance = 8, budgetMs = COLLECT_BUDGET_MS, maxItems = 2 } = {}) {
  const deadline = Date.now() + budgetMs;
  let picked = 0;
  while (picked < maxItems && Date.now() < deadline) {
    const drop = nearestDrop(bot, maxDistance);
    if (!drop) break;
    const dist = drop.position.distanceTo(bot.entity.position);
    try {
      if (dist > 1.6) {
        const goal = new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.9);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          bot.pathfinder.stop();
        }, Math.min(700, Math.max(250, deadline - Date.now())));
        try {
          await bot.pathfinder.goto(goal);
        } catch {
          if (!timedOut) {
            await bot.lookAt(drop.position);
            await hold(bot, "forward", 180);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      await sleep(120);
      picked += 1;
    } catch {
      break;
    }
  }
  return picked;
}

async function gotoNear(bot, position, range = 2, timeoutMs = PATH_TIMEOUT_MS) {
  const dist = bot.entity.position.distanceTo(position);
  if (dist <= range + 0.5) return true;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    bot.pathfinder.stop();
  }, timeoutMs);
  try {
    await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, range));
    return !timedOut;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function findMineTarget(bot) {
  const tier = pickaxeTier(bot);
  const names = [];
  if (tier >= 3) names.push(...DIAMOND_ORES, ...IRON_ORES, ...COAL_ORES);
  else if (tier >= 2) names.push(...IRON_ORES, ...COAL_ORES, ...STONE_BLOCKS);
  else if (tier >= 1) names.push(...COAL_ORES, ...STONE_BLOCKS);
  names.push(...LOGS);

  const ids = names.map((name) => bot.registry.blocksByName[name]?.id).filter(Boolean);
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance: 22 });
}

async function ensureFurnacePlaced(bot) {
  const existing = bot.findBlock({
    matching: bot.registry.blocksByName.furnace?.id,
    maxDistance: 16
  });
  if (existing) return existing;

  const furnaceItem = bot.inventory.items().find((item) => item.name === "furnace");
  if (!furnaceItem) return null;
  await bot.equip(furnaceItem, "hand");
  const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!below || below.name === "air") return null;
  try {
    await bot.placeBlock(below, new Vec3(1, 0, 0));
  } catch {
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      return null;
    }
  }
  await sleep(300);
  return bot.findBlock({
    matching: bot.registry.blocksByName.furnace?.id,
    maxDistance: 8
  });
}

async function smeltRawIron(bot, count = 1) {
  const raw = bot.inventory.items().find((item) => item.name === "raw_iron");
  if (!raw) return { ok: false, reason: "no_raw_iron" };
  const fuel = findFuel(bot);
  if (!fuel) return { ok: false, reason: "no_fuel" };

  const furnaceBlock = await ensureFurnacePlaced(bot);
  if (!furnaceBlock) return { ok: false, reason: "no_furnace" };

  await gotoNear(bot, furnaceBlock.position, 2, PATH_TIMEOUT_MS);
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    // Take any finished output first
    if (furnace.outputItem()) {
      await furnace.takeOutput();
    }
    const smeltCount = Math.min(count, raw.count, 3);
    await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.max(1, smeltCount)));
    await furnace.putInput(raw.type, null, smeltCount);

    const started = Date.now();
    while (Date.now() - started < 11000) {
      await sleep(400);
      if (furnace.outputItem()) {
        await furnace.takeOutput();
        return { ok: true, crafted: "iron_ingot", smelted: true };
      }
    }
    // Partial progress: still close UI
    if (furnace.outputItem()) {
      await furnace.takeOutput();
      return { ok: true, crafted: "iron_ingot", smelted: true };
    }
    return { ok: false, reason: "smelt_timeout" };
  } finally {
    furnace.close();
  }
}

async function digBlock(bot, block) {
  if (!block || block.name === "air") return { ok: false, reason: "no_block" };
  if (BLOCK_TIER[block.name] != null && !canMineBlock(bot, block.name)) {
    return { ok: false, reason: "need_better_pickaxe", wasted: true };
  }
  if (!bot.canDigBlock(block)) return { ok: false, reason: "cannot_dig" };

  // Equip best pick before mining ores/stone
  if (BLOCK_TIER[block.name] != null) {
    await equipBestTool(bot);
  }

  const digPos = block.position.clone();
  await gotoNear(bot, digPos, 2, PATH_TIMEOUT_MS);

  const target = bot.blockAt(digPos) ?? block;
  if (!target || target.name === "air") {
    const picked = await collectNearbyDrops(bot, { budgetMs: COLLECT_BUDGET_MS });
    return picked > 0 ? { ok: true, picked } : { ok: false, reason: "block_gone" };
  }
  if (BLOCK_TIER[target.name] != null && !canMineBlock(bot, target.name)) {
    return { ok: false, reason: "need_better_pickaxe", wasted: true };
  }
  if (!bot.canDigBlock(target)) return { ok: false, reason: "cannot_dig" };

  await bot.dig(target, true);
  await sleep(80);
  const picked = await collectNearbyDrops(bot);
  return { ok: true, picked, mined: target.name };
}

async function digLooking(bot) {
  let block = bot.blockAtCursor(4);
  if (!block || block.name === "air" || block.name === "water" || block.name === "lava") {
    const picked = await collectNearbyDrops(bot, { budgetMs: Math.min(600, COLLECT_BUDGET_MS) });
    if (picked > 0) return { ok: true, picked };
    block = findMineTarget(bot);
    if (!block) return { ok: false, reason: "no_block" };
  }
  return digBlock(bot, block);
}

async function placeHeld(bot) {
  let item = bot.heldItem;
  // Prefer placing furnace / crafting table if we have them and nothing useful held
  if (!item || item.name === "air") {
    item = bot.inventory.items().find((i) => i.name === "furnace" || i.name === "crafting_table");
    if (!item) return { ok: false, reason: "empty_hand" };
    await bot.equip(item, "hand");
  }
  if (item.name === "crafting_table" && findNearbyCraftingTable(bot, 16)) {
    return { ok: false, reason: "table_already_placed" };
  }
  if (item.name === "furnace") {
    const existing = bot.findBlock({
      matching: bot.registry.blocksByName.furnace?.id,
      maxDistance: 16
    });
    if (existing) return { ok: false, reason: "furnace_already_placed" };
  }
  const cursor = bot.blockAtCursor(4);
  const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  const reference = cursor && cursor.name !== "air" ? cursor : below;
  if (!reference || reference.name === "air") return { ok: false, reason: "no_reference" };
  try {
    await bot.placeBlock(reference, new Vec3(0, 1, 0));
    return { ok: true, placed: item.name, newlyPlaced: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function findNearbyCraftingTable(bot, maxDistance = 16) {
  return bot.findBlock({
    matching: bot.registry.blocksByName.crafting_table?.id,
    maxDistance
  });
}

async function ensureCraftingTablePlaced(bot) {
  const existing = findNearbyCraftingTable(bot, 16);
  if (existing) return { table: existing, newlyPlaced: false };

  const tableItem = bot.inventory.items().find((item) => item.name === "crafting_table");
  if (!tableItem) return null;
  await bot.equip(tableItem, "hand");
  const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!below || below.name === "air") return null;
  try {
    await bot.placeBlock(below, new Vec3(0, 1, 0));
  } catch {
    const yaw = bot.entity.yaw;
    const front = bot.blockAt(bot.entity.position.offset(
      -Math.sin(yaw),
      -1,
      -Math.cos(yaw)
    ));
    if (!front || front.name === "air") return null;
    try {
      await bot.placeBlock(front, new Vec3(0, 1, 0));
    } catch {
      return null;
    }
  }
  await sleep(120);
  const table = findNearbyCraftingTable(bot, 8);
  return table ? { table, newlyPlaced: true } : null;
}

function countPlanks(bot) {
  return bot.inventory.items()
    .filter((i) => i.name.endsWith("_planks"))
    .reduce((n, i) => n + i.count, 0);
}

function countLogs(bot) {
  return bot.inventory.items()
    .filter((i) => LOGS.includes(i.name))
    .reduce((n, i) => n + i.count, 0);
}

/** Mineflayer recipes need 3 of the SAME plank type — mixed oak+birch does not count. */
function bestPlankStack(bot) {
  const stacks = new Map();
  for (const item of bot.inventory.items()) {
    if (!item.name.endsWith("_planks")) continue;
    stacks.set(item.name, (stacks.get(item.name) ?? 0) + item.count);
  }
  let name = null;
  let count = 0;
  for (const [n, c] of stacks) {
    if (c > count) {
      name = n;
      count = c;
    }
  }
  return { name, count, stacks };
}

function countSticks(bot) {
  return bot.inventory.items()
    .filter((i) => i.name === "stick")
    .reduce((n, i) => n + i.count, 0);
}

async function craftPlanksBatch(bot, preferPlankName = null) {
  // Prefer logs that grow the plank type we already have (so we can reach 3 matching)
  let log = null;
  if (preferPlankName) {
    const wantLog = `${preferPlankName.replace(/_planks$/, "")}_log`;
    log = bot.inventory.items().find((i) => i.name === wantLog);
  }
  if (!log) log = bot.inventory.items().find((i) => LOGS.includes(i.name));
  if (!log) return { ok: false, reason: "no_log" };
  const plankName = `${log.name.slice(0, -4)}_planks`;
  const item = bot.registry.itemsByName[plankName];
  if (!item) return { ok: false, reason: "no_plank_item" };
  const recipes = bot.recipesFor(item.id, null, 1, null);
  if (!recipes.length) return { ok: false, reason: "no_plank_recipe" };
  const times = Math.min(3, log.count);
  await bot.craft(recipes[0], times, null);
  return { ok: true, crafted: plankName, amount: times * 4 };
}

function getCraftingTableBlock(bot) {
  const cursor = bot.blockAtCursor(6);
  if (cursor?.name === "crafting_table") return cursor;
  return findNearbyCraftingTable(bot, 24);
}

async function ensureTableForCraft(bot) {
  // Prefer the table the bot is already aiming at
  let table = getCraftingTableBlock(bot);
  let newlyPlaced = false;
  if (!table) {
    const ensured = await ensureCraftingTablePlaced(bot);
    table = ensured?.table ?? null;
    newlyPlaced = Boolean(ensured?.newlyPlaced);
  }
  if (!table) {
    const hasItem = bot.inventory.items().some((i) => i.name === "crafting_table");
    return { table: null, newlyPlaced: false, hasItem };
  }
  await bot.lookAt(table.position.offset(0.5, 0.5, 0.5)).catch(() => {});
  const near = await gotoNear(bot, table.position, 3, Math.max(PATH_TIMEOUT_MS, 4000));
  table = getCraftingTableBlock(bot) ?? findNearbyCraftingTable(bot, 8) ?? table;
  await bot.lookAt(table.position.offset(0.5, 0.5, 0.5)).catch(() => {});
  return { table, newlyPlaced, reached: near };
}

async function craftItemWithTable(bot, itemName, table) {
  const item = bot.registry.itemsByName[itemName];
  if (!item) return { ok: false, reason: "unknown_item", item: itemName };
  if (!table) return { ok: false, reason: "no_table" };

  // Close stale windows so mineflayer's craft can open the table cleanly
  if (bot.currentWindow) {
    try {
      bot.closeWindow(bot.currentWindow);
    } catch {
      // ignore
    }
    await sleep(150);
  }

  await bot.lookAt(table.position.offset(0.5, 0.5, 0.5)).catch(() => {});
  let recipes = bot.recipesFor(item.id, null, 1, table);
  if (!recipes.length) {
    await sleep(250);
    recipes = bot.recipesFor(item.id, null, 1, table);
  }
  if (!recipes.length) {
    return {
      ok: false,
      reason: "recipe_missing",
      item: itemName,
      planksTotal: countPlanks(bot),
      ...bestPlankStack(bot),
      sticks: countSticks(bot)
    };
  }

  try {
    await Promise.race([
      bot.craft(recipes[0], 1, table),
      sleep(10000).then(() => {
        throw new Error("craft_timeout");
      })
    ]);
    return { ok: true, crafted: itemName };
  } catch (error) {
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch {
        // ignore
      }
    }
    return { ok: false, reason: "craft_failed", item: itemName, error: error.message };
  }
}

/**
 * When materials are ready, craft the wooden pickaxe immediately.
 * Requires 3 matching planks + 2 sticks + a placed crafting table.
 */
async function tryCraftWoodenPickaxe(bot) {
  if (pickaxeTier(bot) >= 1) return null;
  const sticks = countSticks(bot);
  const { name: plankName, count: samePlanks } = bestPlankStack(bot);
  if (sticks < 2) return { ok: false, reason: "need_sticks", sticks };
  if (samePlanks < 3) {
    if (countLogs(bot) > 0) {
      return craftPlanksBatch(bot, plankName);
    }
    return {
      ok: false,
      reason: "need_same_planks",
      planksTotal: countPlanks(bot),
      bestPlank: plankName,
      bestCount: samePlanks
    };
  }

  const { table, newlyPlaced } = await ensureTableForCraft(bot);
  if (newlyPlaced) return { ok: true, placed: "crafting_table", newlyPlaced: true };
  if (!table) {
    if (samePlanks >= 4) {
      const tableItem = bot.registry.itemsByName.crafting_table;
      const tableRecipes = bot.recipesFor(tableItem.id, null, 1, null);
      if (tableRecipes.length) {
        await bot.craft(tableRecipes[0], 1, null);
        return { ok: true, crafted: "crafting_table" };
      }
    }
    return { ok: false, reason: "need_place_table", want: "wooden_pickaxe" };
  }

  return craftItemWithTable(bot, "wooden_pickaxe", table);
}

async function craftSticks(bot) {
  const stickItem = bot.registry.itemsByName.stick;
  if (!stickItem) return { ok: false, reason: "no_stick_item" };
  // 2×2 recipe — no crafting table required
  const recipes = bot.recipesFor(stickItem.id, null, 1, null);
  if (!recipes.length) {
    return {
      ok: false,
      reason: "stick_recipe_missing",
      ...bestPlankStack(bot)
    };
  }
  try {
    await bot.craft(recipes[0], 1, null);
    return { ok: true, crafted: "stick" };
  } catch (error) {
    return { ok: false, reason: "stick_craft_failed", error: error.message };
  }
}

async function craftNext(bot, craftCursor) {
  const count = (name) => bot.inventory.items()
    .filter((i) => i.name === name)
    .reduce((n, i) => n + i.count, 0);
  const has = (name) => count(name) > 0;
  const hasLog = countLogs(bot) > 0;
  const plankCount = countPlanks(bot);
  const { name: bestPlank, count: samePlanks } = bestPlankStack(bot);
  const tier = pickaxeTier(bot);
  const tableNearby = Boolean(findNearbyCraftingTable(bot, 16));
  const tableReady = has("crafting_table") || tableNearby;
  const sticks = countSticks(bot);
  const needWoodPick = tier < 1;
  const needSticks = sticks < 2 && (
    needWoodPick
    || (count("cobblestone") >= 3 && tier < 2)
    || (count("iron_ingot") >= 3 && tier < 3)
    || (count("diamond") >= 3 && !has("diamond_pickaxe"))
  );

  if (has("raw_iron") && findFuel(bot) && (has("furnace") || bot.findBlock({
    matching: bot.registry.blocksByName.furnace?.id,
    maxDistance: 16
  }))) {
    const smelted = await smeltRawIron(bot, Math.min(3, count("raw_iron")));
    if (smelted.ok) return smelted;
  }

  // --- Early wood tech tree (classic order) ---
  // 1) Get at least 2 matching planks for sticks (2×2, no table)
  if (needSticks && samePlanks < 2) {
    if (hasLog) return craftPlanksBatch(bot, bestPlank);
    return { ok: false, reason: "need_more_logs", bestPlank, bestCount: samePlanks };
  }
  // 2) Craft sticks ASAP once we have 2 matching planks
  if (needSticks && samePlanks >= 2) {
    return craftSticks(bot);
  }

  // 3) Crafting table (4 planks) then place it
  if (needWoodPick && !tableReady) {
    if (samePlanks < 4) {
      if (hasLog) return craftPlanksBatch(bot, bestPlank);
      return { ok: false, reason: "need_more_planks_for_table", bestCount: samePlanks };
    }
    const tableItem = bot.registry.itemsByName.crafting_table;
    const tableRecipes = bot.recipesFor(tableItem.id, null, 1, null);
    if (tableRecipes.length && !has("crafting_table")) {
      await bot.craft(tableRecipes[0], 1, null);
      return { ok: true, crafted: "crafting_table" };
    }
  }
  if (has("crafting_table") && !tableNearby) {
    const ensured = await ensureCraftingTablePlaced(bot);
    if (ensured?.newlyPlaced) {
      return { ok: true, placed: "crafting_table", newlyPlaced: true };
    }
  }

  // 4) Wooden pickaxe when sticks + 3 matching planks + table
  if (needWoodPick && sticks >= 2) {
    if (samePlanks < 3 && hasLog) return craftPlanksBatch(bot, bestPlank);
    if (samePlanks >= 3) {
      const pick = await tryCraftWoodenPickaxe(bot);
      if (pick) return pick;
    }
  }

  // --- Later tech ---
  const priority = [];
  if (hasLog && samePlanks < 8) {
    const log = bot.inventory.items().find((i) => {
      if (bestPlank) return i.name === `${bestPlank.replace(/_planks$/, "")}_log`;
      return LOGS.includes(i.name);
    }) ?? bot.inventory.items().find((i) => LOGS.includes(i.name));
    if (log) priority.push(`${log.name.slice(0, -4)}_planks`);
  }
  if (count("cobblestone") >= 3 && sticks >= 2 && tier < 2) priority.push("stone_pickaxe");
  if (count("cobblestone") >= 8 && !has("furnace") && !bot.findBlock({
    matching: bot.registry.blocksByName.furnace?.id,
    maxDistance: 16
  })) {
    priority.push("furnace");
  }
  if (count("iron_ingot") >= 3 && sticks >= 2 && tier < 3) priority.push("iron_pickaxe");
  if (count("diamond") >= 3 && sticks >= 2 && !has("diamond_pickaxe")) {
    priority.push("diamond_pickaxe");
  }
  // Top up sticks if somehow below 2 again
  if (sticks < 2 && samePlanks >= 2) priority.unshift("stick");

  const rotated = CRAFT_TARGETS.slice(craftCursor % CRAFT_TARGETS.length)
    .concat(CRAFT_TARGETS.slice(0, craftCursor % CRAFT_TARGETS.length));
  const candidates = [
    ...priority,
    ...rotated.filter((name) => name !== "iron_ingot")
  ];

  let walkedToTable = false;
  for (const itemName of candidates) {
    const item = bot.registry.itemsByName[itemName];
    if (!item) continue;
    if (itemName === "stick" && sticks >= 8) continue;
    if (itemName === "stick" && samePlanks < 2) continue;
    if (itemName === "crafting_table" && tableReady) continue;

    if (itemName === "stick") return craftSticks(bot);

    if (itemName === "wooden_pickaxe") {
      const pick = await tryCraftWoodenPickaxe(bot);
      if (pick) return pick;
      continue;
    }

    if (itemName.endsWith("_planks") && hasLog) {
      return craftPlanksBatch(bot, bestPlank);
    }

    let recipes = bot.recipesFor(item.id, null, 1, null);
    let table = null;
    if (!recipes.length) {
      const ensured = await ensureTableForCraft(bot);
      table = ensured.table;
      if (ensured.newlyPlaced) {
        return { ok: true, placed: "crafting_table", newlyPlaced: true };
      }
      if (table) {
        walkedToTable = true;
        recipes = bot.recipesFor(item.id, null, 1, table);
      }
    }
    if (!recipes.length) {
      if (itemName.endsWith("_pickaxe") || itemName === "furnace") {
        if (has("crafting_table") || tableNearby) {
          return { ok: false, reason: "need_place_table", want: itemName };
        }
      }
      continue;
    }
    if (table) return craftItemWithTable(bot, itemName, table);
    try {
      await bot.craft(recipes[0], 1, null);
      return { ok: true, crafted: itemName };
    } catch (error) {
      return { ok: false, reason: "craft_failed", item: itemName, error: error.message };
    }
  }
  if (walkedToTable) return { ok: false, reason: "idle_at_table" };
  if (needWoodPick && samePlanks < 3 && !hasLog) {
    return { ok: false, reason: "need_more_logs", bestPlank, bestCount: samePlanks };
  }
  return { ok: false, reason: "no_craftable", bestPlank, bestCount: samePlanks, sticks };
}

async function equipBestTool(bot) {
  const tools = bot.inventory.items().filter((item) =>
    item.name.includes("pickaxe") || item.name.includes("axe") || item.name.includes("sword")
  );
  if (!tools.length) return { ok: false, reason: "no_tool" };
  const rank = (name) => {
    if (name.startsWith("netherite_") || name.startsWith("diamond_")) return 4;
    if (name.startsWith("iron_")) return 3;
    if (name.startsWith("stone_")) return 2;
    if (name.startsWith("wooden_") || name.startsWith("golden_")) return 1;
    return 0;
  };
  tools.sort((a, b) => rank(b.name) - rank(a.name));
  await bot.equip(tools[0], "hand");
  return { ok: true, equipped: tools[0].name };
}

async function executePrimitive(bot, name, state) {
  clearControl(bot);
  switch (name) {
    case "WAIT":
      await sleep(WAIT_MS);
      return { ok: true };
    case "FORWARD":
      await hold(bot, "forward", MOVE_MS);
      return { ok: true };
    case "BACK":
      await hold(bot, "back", MOVE_MS);
      return { ok: true };
    case "STRAFE_LEFT":
      await hold(bot, "left", MOVE_MS);
      return { ok: true };
    case "STRAFE_RIGHT":
      await hold(bot, "right", MOVE_MS);
      return { ok: true };
    case "TURN_LEFT":
      await bot.look(bot.entity.yaw + Math.PI / 4, bot.entity.pitch, false);
      return { ok: true };
    case "TURN_RIGHT":
      await bot.look(bot.entity.yaw - Math.PI / 4, bot.entity.pitch, false);
      return { ok: true };
    case "LOOK_UP":
      await bot.look(bot.entity.yaw, Math.min(1.2, bot.entity.pitch + 0.35), false);
      return { ok: true };
    case "LOOK_DOWN":
      await bot.look(bot.entity.yaw, Math.max(-1.2, bot.entity.pitch - 0.35), false);
      return { ok: true };
    case "JUMP":
      await hold(bot, "jump", 120);
      return { ok: true };
    case "DIG_LOOKING":
      return digLooking(bot);
    case "PLACE_HELD":
      return placeHeld(bot);
    case "ATTACK": {
      const entity = bot.nearestEntity((e) => e.type === "mob" || e.type === "player");
      if (!entity) return { ok: false, reason: "no_target" };
      await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      await bot.attack(entity);
      return { ok: true };
    }
    case "USE_ITEM": {
      // Looking at a crafting table → actually craft (don't just open the UI)
      const cursor = bot.blockAtCursor(6);
      if (cursor?.name === "crafting_table") {
        const pick = await tryCraftWoodenPickaxe(bot);
        if (pick) return { ...pick, via: "use_table" };
        const crafted = await craftNext(bot, state.craftCursor ?? 0);
        state.craftCursor = ((state.craftCursor ?? 0) + 1) % CRAFT_TARGETS.length;
        return { ...crafted, via: "use_table" };
      }
      if (cursor?.name === "furnace" && countName(bot, "raw_iron") > 0 && findFuel(bot)) {
        return smeltRawIron(bot, 1);
      }
      // Prefer smelting when holding raw iron / standing by furnace needs
      if (countName(bot, "raw_iron") > 0 && findFuel(bot)) {
        return smeltRawIron(bot, 1);
      }
      if (!bot.heldItem) return { ok: false, reason: "empty_hand" };
      await bot.activateItem();
      await sleep(200);
      bot.deactivateItem();
      return { ok: true };
    }
    case "EAT": {
      const food = bot.inventory.items().find((item) => item.foodPoints);
      if (!food) return { ok: false, reason: "no_food" };
      await bot.equip(food, "hand");
      await bot.consume();
      return { ok: true };
    }
    case "SWAP_HOTBAR": {
      state.hotbar = ((state.hotbar ?? 0) + 1) % 9;
      bot.setQuickBarSlot(state.hotbar);
      return { ok: true };
    }
    case "DROP_HELD":
      if (!bot.heldItem) return { ok: false, reason: "empty_hand" };
      await bot.tossStack(bot.heldItem);
      return { ok: true };
    case "CRAFT_NEXT": {
      const result = await craftNext(bot, state.craftCursor ?? 0);
      state.craftCursor = ((state.craftCursor ?? 0) + 1) % CRAFT_TARGETS.length;
      return result;
    }
    case "EQUIP_BEST_TOOL":
      return equipBestTool(bot);
    case "PATH_TO_LOOK": {
      let block = bot.blockAtCursor(24);
      if (block?.name === "crafting_table" || (!block && findNearbyCraftingTable(bot, 8))) {
        const pick = await tryCraftWoodenPickaxe(bot);
        if (pick?.ok || pick?.crafted === "wooden_pickaxe") return { ...pick, via: "path_to_table" };
      }
      if (!block || block.name === "air") {
        block = findMineTarget(bot);
      }
      if (!block) return { ok: false, reason: "no_look_target" };
      const ok = await gotoNear(bot, block.position, 1, PATH_TIMEOUT_MS);
      return ok ? { ok: true, target: block.name } : { ok: false, reason: "path_timeout" };
    }
    default:
      return { ok: false, reason: "unknown_primitive" };
  }
}

async function replayInvented(bot, skill, state) {
  if (!skill?.sequence?.length) return { ok: false, reason: "empty_invented" };
  let last = { ok: true };
  for (const primitiveIndex of skill.sequence) {
    const name = PRIMITIVES[primitiveIndex];
    if (!name) return { ok: false, reason: "bad_sequence" };
    last = await executePrimitive(bot, name, state);
  }
  return { ...last, invented: skill.name };
}

export function actionNames(inventedSkills = []) {
  const names = [...PRIMITIVES];
  for (let i = 0; i < MAX_INVENTED; i += 1) {
    names.push(inventedSkills[i]?.name ?? `INVENTED_EMPTY_${i}`);
  }
  return names;
}

export async function executeAction(bot, action, state, inventedSkills = []) {
  const index = Number(action);
  if (index < 0 || index >= ACTION_SIZE) {
    return { ok: false, reason: "out_of_range" };
  }
  if (index < PRIMITIVES.length) {
    const result = await executePrimitive(bot, PRIMITIVES[index], state);
    return { ...result, kind: "primitive", name: PRIMITIVES[index] };
  }
  const inventedIndex = index - PRIMITIVES.length;
  const skill = inventedSkills[inventedIndex];
  if (!skill) return { ok: false, reason: "slot_empty", kind: "invented", name: `INVENTED_EMPTY_${inventedIndex}` };
  const result = await replayInvented(bot, skill, state);
  return { ...result, kind: "invented", name: skill.name };
}

export function isPrimitiveAction(action) {
  return Number(action) >= 0 && Number(action) < PRIMITIVES.length;
}

export function nearestLogHint(bot) {
  const ids = LOGS.map((name) => bot.registry.blocksByName[name]?.id).filter(Boolean);
  return bot.findBlock({ matching: ids, maxDistance: 22 });
}

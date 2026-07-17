import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Rcon } from "rcon-client";
import { WebSocketServer } from "ws";
import { SkillInventor } from "./discovery.js";
import { milestoneState, OBSERVATION_SIZE, snapshot } from "./observations.js";
import {
  ACTION_SIZE,
  actionNames,
  executeAction,
  MAX_INVENTED,
  PRIMITIVES
} from "./skills.js";
import { botStatus } from "./status.js";

const { pathfinder, Movements } = pathfinderPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const botRank = Math.max(0, Number(process.env.BOT_RANK ?? 0));
const padSpacing = Math.max(0, Number(process.env.PAD_SPACING ?? 1000));
const sharedServer = process.env.SHARED_SERVER === "1" || process.env.SHARED_SERVER === "true";

const config = {
  mcHost: process.env.MC_HOST ?? "127.0.0.1",
  mcPort: Number(process.env.MC_PORT ?? 25565),
  mcVersion: process.env.MC_VERSION ?? "1.21.4",
  username: process.env.BOT_USERNAME ?? `rl_bot_${botRank}`,
  botRank,
  padSpacing,
  padX: botRank * padSpacing,
  padZ: 0,
  sharedServer,
  wsPort: Number(process.env.WS_PORT ?? 8765),
  viewerPort: Number(process.env.VIEWER_PORT ?? 3000),
  statusPort: Number(process.env.STATUS_PORT ?? 8865),
  rconHost: process.env.RCON_HOST ?? process.env.MC_HOST ?? "127.0.0.1",
  rconPort: Number(process.env.RCON_PORT ?? 25575),
  rconPassword: process.env.RCON_PASSWORD ?? "minecraft-rl",
  actionTimeoutMs: Number(process.env.ACTION_TIMEOUT_MS ?? 12000),
  episodeSteps: Number(process.env.EPISODE_STEPS ?? 256),
  wipeEvery: Number(process.env.WIPE_EVERY_EPISODES ?? 15),
  softResetSleepMs: Number(process.env.SOFT_RESET_SLEEP_MS ?? 250),
  enableViewer: process.env.ENABLE_VIEWER !== "0" && process.env.ENABLE_VIEWER !== "false",
  initialStage: Math.max(0, Math.min(19, Number(process.env.STAGE ?? 2))),
  serverDir: process.env.MC_SERVER_DIR
    ?? path.join(PROJECT_ROOT, "runtime", "mc0")
};

let bot;
let ready = false;
let dead = false;
let episodeStep = 0;
let stage = config.initialStage;
let previousMilestones = {};
let rcon;
let episodeResets = 0;
let suppressReconnect = false;
let viewerStarted = false;
/** Once-true flags so dig/re-place cannot re-farm milestone rewards. */
let episodeMilestones = {};
let rewardedTablePlace = false;
/** How many times the current stage goal was achieved (process lifetime). */
let stageCompletions = 0;
/** Ender Dragon kill tracking (reset each episode). */
let dragonSeen = false;
let dragonKilled = false;
const inventor = new SkillInventor();
const controlState = { hotbar: 0, craftCursor: 0 };
/** Fine-grained tech-tree goals, one per stage id (0..19). */
const STAGE_GOALS = [
  "log", "planks", "crafting_table", "wooden_pickaxe", "cobblestone",
  "stone_pickaxe", "furnace", "raw_iron", "iron_ingot", "iron_pickaxe",
  "diamond", "diamond_pickaxe", "obsidian", "flint_and_steel", "nether",
  "blaze_rod", "ender_pearl", "ender_eye", "end", "dragon_killed"
];
const MAX_STAGE = STAGE_GOALS.length - 1;
/** Short, per-stage episode budgets (steps) so each goal is trainable. */
const STAGE_STEPS = [
  256, 256, 256, 384, 384, 384, 384, 512, 512, 512,
  768, 768, 768, 512, 768, 1024, 1024, 768, 1536, 2048
];

function isBotUsername(username) {
  return /^rl_bot_\d+$/i.test(username) || username === config.username;
}

async function opNonBotPlayer(username) {
  if (!username || isBotUsername(username)) return;
  try {
    const client = await getRcon();
    await client.send(`op ${username}`);
    console.log(`Granted op to ${username}`);
  } catch (error) {
    console.warn(`Failed to op ${username}:`, error.message);
  }
}

async function opAllNonBotPlayers() {
  if (!bot?.players) return;
  for (const username of Object.keys(bot.players)) {
    await opNonBotPlayer(username);
  }
}

function externalMilestones() {
  return { dragon_killed: dragonKilled };
}

function observe() {
  return snapshot(bot, stage, inventor.list().length, MAX_INVENTED, externalMilestones());
}

/** Per-stage step budget; falls back to the configured global when out of range. */
function stageStepLimit() {
  return STAGE_STEPS[stage] ?? config.episodeSteps;
}

function isDragonEntity(entity) {
  if (!entity) return false;
  return entity.name === "ender_dragon"
    || entity.displayName === "Ender Dragon"
    || entity.entityType === bot?.registry?.entitiesByName?.ender_dragon?.id;
}

function actionInfo() {
  return {
    stage,
    actions: actionNames(inventor.list()),
    primitives: PRIMITIVES,
    invented: inventor.list(),
    actionSize: ACTION_SIZE,
    primitiveCount: PRIMITIVES.length,
    maxInvented: MAX_INVENTED,
    observationSize: OBSERVATION_SIZE
  };
}

function stageGoalName() {
  return STAGE_GOALS[stage] ?? "unknown";
}

function getPublicStatus() {
  return botStatus(bot, {
    username: config.username,
    ready,
    dead,
    stage,
    stageGoal: stageGoalName(),
    stageCompletions,
    episodeStep,
    episodeResets,
    wipeEvery: config.wipeEvery,
    milestones: ready ? milestoneState(bot, externalMilestones()) : {},
    inventedCount: inventor.list().length,
    viewerUrl: `http://127.0.0.1:${config.viewerPort}`,
    wsPort: config.wsPort,
    mcPort: config.mcPort,
    statusPort: config.statusPort
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function ensureViewer() {
  if (!config.enableViewer || viewerStarted || !bot) return;
  // Stagger viewer binds so 20 bots don't all open ports at once
  await new Promise((resolve) => setTimeout(resolve, 250 * config.botRank));
  if (viewerStarted) return;
  if (!(await portIsFree(config.viewerPort))) {
    console.warn(`Viewer port :${config.viewerPort} busy — retry in 5s`);
    setTimeout(() => {
      viewerStarted = false;
      ensureViewer().catch(() => {});
    }, 5000);
    return;
  }
  try {
    const viewerPkg = await import("prismarine-viewer");
    const mineflayerViewer = viewerPkg.mineflayer;
    const app = mineflayerViewer(bot, {
      port: config.viewerPort,
      firstPerson: true,
      viewDistance: 2
    });
    app?.server?.on?.("error", (error) => {
      console.warn("Viewer server error (ignored):", error.message);
      viewerStarted = false;
    });
    viewerStarted = true;
    console.log(`First-person viewer on :${config.viewerPort}`);
  } catch (error) {
    console.warn("Viewer unavailable (training still works):", error.message);
    // Allow one later retry after spawn stress settles
    setTimeout(() => {
      if (!viewerStarted) {
        ensureViewer().catch(() => {});
      }
    }, 10000);
  }
}

function createBot() {
  ready = false;
  dead = false;
  bot = mineflayer.createBot({
    host: config.mcHost,
    port: config.mcPort,
    username: config.username,
    version: config.mcVersion,
    auth: "offline",
    checkTimeoutInterval: 60000
  });
  bot.loadPlugin(pathfinder);
  bot.once("spawn", async () => {
    const movements = new Movements(bot);
    movements.canDig = true;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);
    ready = true;
    console.log(`Bot ${config.username} spawned on ${config.mcHost}:${config.mcPort} (stage ${stage} → ${stageGoalName()})`);
    ensureViewer().catch(() => {});
    await opAllNonBotPlayers();
  });
  bot.on("playerJoined", (player) => {
    void opNonBotPlayer(player.username);
  });
  bot.on("death", () => {
    dead = true;
  });
  // Ender Dragon kill detection: we must have seen the dragon alive, then it
  // dies / despawns while we are in the End dimension.
  bot.on("entitySpawn", (entity) => {
    if (isDragonEntity(entity)) dragonSeen = true;
  });
  bot.on("entityDead", (entity) => {
    if (isDragonEntity(entity)) dragonKilled = true;
  });
  bot.on("entityGone", (entity) => {
    const inEnd = ["the_end", "minecraft:the_end"].includes(bot.game?.dimension);
    if (isDragonEntity(entity) && dragonSeen && inEnd) dragonKilled = true;
  });
  bot.on("end", () => {
    ready = false;
    if (!suppressReconnect) setTimeout(createBot, 3000);
  });
  bot.on("kicked", (reason) => console.error("Kicked:", reason));
  bot.on("error", (error) => console.error("Mineflayer error:", error.message));
}

async function getRcon() {
  if (rcon) return rcon;
  rcon = await Rcon.connect({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword
  });
  rcon.on("end", () => {
    rcon = null;
  });
  return rcon;
}

function waitUntilReady(timeoutMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("bot_ready_timeout"));
      }
    }, 250);
  });
}

async function ensureReady(timeoutMs = 90000) {
  if (ready && bot) return;
  if (!bot && !suppressReconnect) createBot();
  await waitUntilReady(timeoutMs);
}

function runWipeScript() {
  const script = path.join(PROJECT_ROOT, "scripts", "wipe_world.sh");
  return new Promise((resolve, reject) => {
    const child = spawn(script, [config.serverDir, String(config.mcPort)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`wipe_world.sh exited ${code}: ${output}`));
    });
  });
}

async function wipeWorld() {
  // Shared world: only rank 0 may wipe; other ranks just wait for reconnect.
  if (config.sharedServer && config.botRank !== 0) {
    console.log(`Rank ${config.botRank}: skipping wipe (rank 0 owns shared world)`);
    await ensureReady(300000).catch(() => {});
    return false;
  }
  console.log(`Full world wipe for ${config.serverDir} (every ${config.wipeEvery} episodes)`);
  suppressReconnect = true;
  try {
    try {
      await rcon?.end();
    } catch {
      // ignore
    }
    rcon = null;
    try {
      bot?.quit("world_wipe");
    } catch {
      // ignore
    }
    ready = false;
    // Keep viewerStarted=true so we do not re-bind the viewer port after wipe.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runWipeScript();
    createBot();
    await waitUntilReady(300000);
    return true;
  } catch (error) {
    console.warn("World wipe failed — falling back to soft reset:", error.message);
    if (!ready) {
      try {
        createBot();
        await waitUntilReady(120000);
      } catch (reconnectError) {
        console.warn("Reconnect after failed wipe:", reconnectError.message);
      }
    }
    return false;
  } finally {
    suppressReconnect = false;
  }
}

const UNSAFE_FLOOR = new Set([
  "air", "cave_air", "void_air", "water", "lava", "bubble_column",
  "kelp", "kelp_plant", "seagrass", "tall_seagrass", "powder_snow",
  "fire", "soul_fire", "magma_block", "cactus", "sweet_berry_bush",
  "cobweb", "ice", "frosted_ice", "packed_ice", "blue_ice"
]);

function isSpawnSafe() {
  if (!bot?.entity) return false;
  const pos = bot.entity.position;
  const y = pos.y;
  if (y < -60 || y > 220) return false;
  const below = bot.blockAt(pos.offset(0, -1, 0));
  const feet = bot.blockAt(pos);
  const head = bot.blockAt(pos.offset(0, 1, 0));
  if (!below || UNSAFE_FLOOR.has(below.name)) return false;
  if (!below.boundingBox || below.boundingBox === "empty") return false;
  // Feet/head must be breathable (not submerged in fluid / solid).
  for (const block of [feet, head]) {
    if (!block) continue;
    if (block.name === "water" || block.name === "lava" || block.name === "bubble_column") {
      return false;
    }
    if (block.boundingBox === "block") return false;
  }
  return true;
}

async function rconSpread(client, name, x, z, spread, range) {
  // `under 120` keeps spawns on surface land, not deep ocean floor / caves.
  try {
    await client.send(
      `execute in minecraft:overworld run spreadplayers ${x} ${z} ${spread} ${range} under 120 false ${name}`
    );
  } catch {
    await client.send(
      `execute in minecraft:overworld run spreadplayers ${x} ${z} ${spread} ${range} false ${name}`
    );
  }
}

async function forceLandPlatform(client, name, x, z) {
  const y = 72;
  await client.send(
    `execute in minecraft:overworld run fill ${x - 2} ${y} ${z - 2} ${x + 2} ${y} ${z + 2} minecraft:grass_block`
  );
  await client.send(
    `execute in minecraft:overworld run fill ${x - 2} ${y + 1} ${z - 2} ${x + 2} ${y + 3} ${z + 2} minecraft:air`
  );
  await client.send(`execute in minecraft:overworld run tp ${name} ${x + 0.5} ${y + 1} ${z + 0.5}`);
}

async function teleportToSafePad(client, name) {
  const baseX = config.padX;
  const baseZ = config.padZ;
  // Try pad center, then nearby offsets so ocean pads can find shore / land.
  const centers = [
    [baseX, baseZ],
    [baseX + 64, baseZ],
    [baseX - 64, baseZ],
    [baseX, baseZ + 64],
    [baseX, baseZ - 64],
    [baseX + 128, baseZ + 128],
    [baseX - 128, baseZ + 128],
    [baseX + 128, baseZ - 128],
    [baseX - 128, baseZ - 128],
    [baseX + 256, baseZ]
  ];

  for (const [x, z] of centers) {
    await client.send(`execute in minecraft:overworld run tp ${name} ${x} 140 ${z}`);
    await rconSpread(client, name, x, z, 8, 96);
    await new Promise((resolve) => setTimeout(resolve, Math.max(400, config.softResetSleepMs)));
    if (isSpawnSafe()) return { x, z, method: "spreadplayers" };
  }

  // Guaranteed dry land near the pad (even in deep ocean).
  await forceLandPlatform(client, name, baseX, baseZ);
  await new Promise((resolve) => setTimeout(resolve, Math.max(400, config.softResetSleepMs)));
  return { x: baseX, z: baseZ, method: "platform" };
}

async function softReset() {
  await ensureReady(90000);
  bot.pathfinder.stop();
  bot.clearControlStates();
  try {
    const client = await getRcon();
    const name = config.username;
    await client.send(`clear ${name}`);
    await client.send(`effect clear ${name}`);
    await client.send(`gamemode survival ${name}`);
    const land = await teleportToSafePad(client, name);
    if (!isSpawnSafe()) {
      // One more hard platform if chunk data lagged the first check.
      await forceLandPlatform(client, name, land.x, land.z);
      await new Promise((resolve) => setTimeout(resolve, Math.max(400, config.softResetSleepMs)));
    }
    await client.send(`effect give ${name} resistance 5 255 true`);
    await client.send(`effect give ${name} slow_falling 3 0 true`);
    if (!config.sharedServer || config.botRank === 0) {
      await client.send(`time set day`);
      await client.send(`weather clear`);
    }
    if (!isSpawnSafe()) {
      console.warn(`Spawn still unsafe for ${name} near pad (${config.padX},${config.padZ})`);
    }
  } catch (error) {
    console.warn("RCON reset unavailable; using respawn only:", error.message);
    if (dead) bot.respawn();
  }
}

async function resetEpisode(requestedStage = 1) {
  await ensureReady(180000).catch(() => {
    throw new Error("bot_not_ready");
  });

  inventor.load();
  inventor.resetEpisode();
  controlState.hotbar = 0;
  controlState.craftCursor = 0;
  stage = Math.max(0, Math.min(MAX_STAGE, Number(requestedStage)));
  episodeStep = 0;
  dead = false;
  dragonSeen = false;
  dragonKilled = false;
  episodeResets += 1;

  let wiped = false;
  const wantWipe = config.wipeEvery > 0 && episodeResets % config.wipeEvery === 0
    && (!config.sharedServer || config.botRank === 0);
  if (wantWipe) {
    wiped = await wipeWorld();
  } else if (config.sharedServer && !ready) {
    // Another rank may have wiped the shared world — wait for Paper + spawn.
    await ensureReady(300000).catch(() => {
      throw new Error("bot_not_ready");
    });
  }
  await softReset();

  previousMilestones = milestoneState(bot, externalMilestones());
  episodeMilestones = { ...previousMilestones };
  rewardedTablePlace = Boolean(
    previousMilestones.crafting_table
    || bot.findBlock?.({
      matching: bot.registry?.blocksByName?.crafting_table?.id,
      maxDistance: 16
    })
  );
  return {
    observation: observe(),
    info: {
      ...actionInfo(),
      episodeResets,
      wiped,
      wipeRequested: wantWipe,
      wipeEvery: config.wipeEvery,
      pad: { x: config.padX, z: config.padZ, rank: config.botRank },
      sharedServer: config.sharedServer
    }
  };
}

/**
 * Extra reward for finishing the stage quickly (fewer episode steps).
 * ~15 if done near step 1, ~1 if finished at the episode limit.
 */
function stageSpeedBonus(steps) {
  const budget = Math.max(1, stageStepLimit());
  const ratio = Math.min(1, Math.max(0, steps / budget));
  return Math.max(0.5, 15 * ((1 - ratio) ** 1.5));
}

function rewardFor(before, after, result, inventedNow, healthBefore, healthAfter) {
  const weights = {
    log: 1.5, planks: 2, crafting_table: 3, wooden_pickaxe: 8,
    cobblestone: 1, stone_pickaxe: 10, furnace: 4,
    raw_iron: 6, iron_ingot: 10, iron_pickaxe: 16,
    diamond: 22, diamond_pickaxe: 36,
    obsidian: 30, flint_and_steel: 24,
    nether: 40, blaze_rod: 50, ender_pearl: 55, ender_eye: 60,
    end: 100, dragon_killed: 300
  };
  let reward = result.ok ? -0.002 : -0.02;
  if (result.reason === "need_pickaxe" || result.reason === "need_better_pickaxe" || result.wasted) {
    reward -= 0.15;
  }
  if (result.reason === "table_already_placed") reward -= 0.05;
  if (result.reason === "idle_at_table") reward -= 0.03;

  // Craft bonuses only for real item outputs
  if (result.crafted === "wooden_pickaxe") reward += 2;
  if (result.crafted === "stone_pickaxe") reward += 2;
  if (result.crafted?.endsWith("_planks") && result.amount >= 4) reward += 0.4;
  if (result.reason === "need_more_planks" || result.reason === "need_more_logs") reward -= 0.02;
  if (result.crafted === "crafting_table") reward += 1;
  if (result.crafted === "furnace") reward += 2;
  if (result.crafted === "iron_pickaxe") reward += 4;
  if (result.crafted === "diamond_pickaxe") reward += 6;
  if (result.crafted === "bucket") reward += 1;
  if (result.crafted === "flint_and_steel") reward += 3;
  if (result.crafted === "blaze_powder") reward += 2;
  if (result.crafted === "ender_eye") reward += 6;
  if (result.lit === "nether_portal") reward += 8;

  // Place table: one bonus per episode only (stops dig/place farming)
  if (result.placed === "crafting_table" && result.newlyPlaced) {
    if (!rewardedTablePlace) {
      reward += 1.5;
      rewardedTablePlace = true;
    } else {
      reward -= 0.2;
    }
  } else if (result.placed === "crafting_table" && !result.newlyPlaced) {
    reward -= 0.05; // visited/opened existing table without placing
  }
  if (result.placed === "furnace" && result.newlyPlaced !== false) reward += 1.5;

  if (result.crafted === "stick") {
    const sticks = bot.inventory.items()
      .filter((item) => item.name === "stick")
      .reduce((n, item) => n + item.count, 0);
    if (sticks > 8) reward -= 0.25;
  }
  if (result.reason === "need_place_table") reward -= 0.05;
  if (result.smelted) reward += 3;
  if (result.mined && (result.mined.includes("iron_ore") || result.mined.includes("diamond_ore"))) {
    reward += 1.5;
  }
  if (result.mined === "obsidian") reward += 3;

  // Sticky milestones: once earned this episode, cannot re-trigger by dig/re-place
  for (const [key, weight] of Object.entries(weights)) {
    if (!before[key] && after[key] && !episodeMilestones[key]) {
      reward += weight;
      episodeMilestones[key] = true;
    }
  }
  if (!before.cobblestone && after.cobblestone && pickaxeMissing(after)) {
    reward -= 0.5;
  }

  const hpBefore = Number.isFinite(healthBefore) ? healthBefore : 20;
  const hpAfter = Number.isFinite(healthAfter) ? healthAfter : hpBefore;
  const deltaHp = hpAfter - hpBefore;
  if (deltaHp < 0) {
    reward += deltaHp * 0.75;
  } else if (deltaHp > 0) {
    reward += deltaHp * 0.05;
  }

  reward += inventedNow.length * 2;
  return reward;
}

function pickaxeMissing(milestones) {
  return !milestones.wooden_pickaxe && !milestones.stone_pickaxe
    && !milestones.iron_pickaxe && !milestones.diamond_pickaxe;
}

async function step(action) {
  await ensureReady(90000).catch(() => {
    throw new Error("bot_not_ready");
  });
  const before = milestoneState(bot, externalMilestones());
  const healthBefore = bot.health ?? 20;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("action_timeout")), config.actionTimeoutMs);
  });
  let result;
  try {
    result = await Promise.race([
      executeAction(bot, Number(action), controlState, inventor.list()),
      timeout
    ]);
  } catch (error) {
    bot.pathfinder.stop();
    bot.clearControlStates();
    result = { ok: false, reason: error.message };
  } finally {
    clearTimeout(timer);
  }

  inventor.record(action, result);
  episodeStep += 1;
  const after = milestoneState(bot, externalMilestones());
  const inventedNow = inventor.maybeInvent(before, after);
  const healthAfter = bot.health ?? 0;
  const goal = STAGE_GOALS[stage];
  const success = Boolean(after[goal]) && !before[goal];
  if (success) stageCompletions += 1;
  const terminated = dead || healthAfter <= 0 || Boolean(after[goal]);
  const truncated = episodeStep >= stageStepLimit();
  const damageTaken = Math.max(0, healthBefore - healthAfter);
  const speedBonus = success ? stageSpeedBonus(episodeStep) : 0;
  const reward = dead || healthAfter <= 0
    ? -10
    : rewardFor(before, after, result, inventedNow, healthBefore, healthAfter)
      + (success ? 10 + speedBonus : 0);
  previousMilestones = after;
  return {
    observation: observe(),
    reward,
    terminated,
    truncated,
    info: {
      ...actionInfo(),
      action: result.name ?? actionNames(inventor.list())[action] ?? "UNKNOWN",
      result,
      milestones: after,
      episodeStep,
      success,
      stageGoal: goal,
      stageCompletions,
      speedBonus,
      inventedNow,
      healthBefore,
      healthAfter,
      damageTaken
    }
  };
}

function send(ws, id, payload, error = null) {
  ws.send(JSON.stringify(error ? { id, error } : { id, ...payload }));
}

const wss = new WebSocketServer({ port: config.wsPort });
wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
      if (message.type === "ping") send(ws, message.id, { ready });
      else if (message.type === "status") send(ws, message.id, getPublicStatus());
      else if (message.type === "reset") send(ws, message.id, await resetEpisode(message.stage));
      else if (message.type === "step") send(ws, message.id, await step(message.action));
      else if (message.type === "skills") send(ws, message.id, { invented: inventor.list(), ...actionInfo() });
      else if (message.type === "close") {
        send(ws, message.id, { closed: true });
        ws.close();
      } else throw new Error("unknown_message_type");
    } catch (error) {
      send(ws, message?.id ?? null, {}, error.message);
    }
  });
});

wss.on("listening", () => {
  console.log(`WebSocket bridge listening on :${config.wsPort}`);
  console.log(`Bot ${config.username} rank=${config.botRank} pad=(${config.padX},${config.padZ}) shared=${config.sharedServer}`);
  console.log(`Action space: ${PRIMITIVES.length} primitives + ${MAX_INVENTED} inventable slots`);
  console.log(`World wipe every ${config.wipeEvery} episode resets (${config.serverDir})`);
});

const statusServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url?.startsWith("/status")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(getPublicStatus()));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
statusServer.listen(config.statusPort, () => {
  console.log(`Status API on :${config.statusPort}/status`);
});

createBot();

process.on("SIGTERM", async () => {
  bot?.quit();
  await rcon?.end();
  statusServer.close();
  wss.close(() => process.exit(0));
});

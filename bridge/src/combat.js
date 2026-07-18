/**
 * Automatic damage reaction: flee from (default) or aim at the attacker.
 * Mode: DAMAGE_REACTION=flee|aim  (default flee)
 */
const FLEE_MS = Number(process.env.DAMAGE_FLEE_MS ?? 500);
const REACTION_MODE = String(process.env.DAMAGE_REACTION ?? "flee").toLowerCase();
const THREAT_RANGE = Number(process.env.DAMAGE_THREAT_RANGE ?? 16);

const PASSIVE_MOBS = new Set([
  "cow", "pig", "sheep", "chicken", "rabbit", "horse", "donkey", "mule",
  "llama", "trader_llama", "cat", "wolf", "parrot", "ocelot", "fox",
  "bee", "turtle", "panda", "polar_bear", "goat", "axolotl", "frog",
  "tadpole", "camel", "sniffer", "allay", "villager", "wandering_trader",
  "iron_golem", "snow_golem", "bat", "squid", "glow_squid", "dolphin",
  "cod", "salmon", "tropical_fish", "pufferfish", "mooshroom", "strider"
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThreat(bot, entity) {
  if (!entity || entity === bot.entity) return false;
  if (entity.type === "player") {
    // Other RL bots are not enemies
    const name = entity.username || entity.name || "";
    if (/^rl_bot_\d+$/i.test(name)) return false;
    return entity.position.distanceTo(bot.entity.position) <= THREAT_RANGE;
  }
  if (entity.type !== "mob" && entity.type !== "hostile") return false;
  const name = entity.name || entity.displayName || "";
  if (PASSIVE_MOBS.has(name)) return false;
  return entity.position.distanceTo(bot.entity.position) <= THREAT_RANGE;
}

function nearestThreat(bot) {
  return bot.nearestEntity((entity) => isThreat(bot, entity));
}

async function aimAtThreat(bot, threat) {
  await bot.lookAt(threat.position.offset(0, (threat.height ?? 1.6) * 0.85, 0)).catch(() => {});
}

async function fleeFromThreat(bot, threat) {
  try {
    bot.pathfinder?.stop?.();
  } catch {
    // ignore
  }
  bot.clearControlStates();

  if (threat?.position) {
    const me = bot.entity.position;
    const dx = me.x - threat.position.x;
    const dz = me.z - threat.position.z;
    // Look away from the attacker, then sprint forward
    await bot.lookAt(me.offset(dx, 0, dz)).catch(() => {});
  }

  bot.setControlState("sprint", true);
  bot.setControlState("forward", true);
  bot.setControlState("jump", true);
  await sleep(FLEE_MS);
  bot.clearControlStates();
}

/**
 * Install health/hurt listeners. Returns a disposer.
 * @param {import('mineflayer').Bot} bot
 * @param {{ mode?: 'flee'|'aim', isAlive?: () => boolean }} options
 */
export function installDamageReaction(bot, options = {}) {
  const mode = (options.mode ?? REACTION_MODE) === "aim" ? "aim" : "flee";
  let lastHp = bot.health ?? 20;
  let busy = false;
  let lastReactAt = 0;

  const react = async (reason) => {
    if (busy) return;
    if (options.isAlive && !options.isAlive()) return;
    if ((bot.health ?? 0) <= 0) return;
    const now = Date.now();
    if (now - lastReactAt < 300) return;
    busy = true;
    lastReactAt = now;
    try {
      const threat = nearestThreat(bot);
      if (mode === "aim" && threat) {
        await aimAtThreat(bot, threat);
        return { ok: true, reaction: "aim", threat: threat.name, reason };
      }
      // Default: run away (also when threat unknown — fall/lava/fire)
      await fleeFromThreat(bot, threat);
      return {
        ok: true,
        reaction: "flee",
        threat: threat?.name ?? null,
        reason
      };
    } catch (error) {
      return { ok: false, reason: error.message };
    } finally {
      busy = false;
    }
  };

  const onHealth = () => {
    const hp = bot.health ?? 20;
    if (hp < lastHp - 0.05) {
      void react("health_drop");
    }
    lastHp = hp;
  };

  const onHurt = (entity) => {
    if (entity !== bot.entity) return;
    void react("entity_hurt");
  };

  bot.on("health", onHealth);
  bot.on("entityHurt", onHurt);

  // Keep lastHp in sync after respawn/heal without fleeing
  bot.on("spawn", () => {
    lastHp = bot.health ?? 20;
  });

  return () => {
    bot.removeListener("health", onHealth);
    bot.removeListener("entityHurt", onHurt);
  };
}

export function inventorySnapshot(bot) {
  if (!bot?.inventory) return [];
  return bot.inventory.items().map((item) => ({
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot
  }));
}

export function botStatus(bot, extras = {}) {
  const pos = bot?.entity?.position;
  return {
    ready: Boolean(bot?.entity),
    username: bot?.username ?? extras.username ?? null,
    health: bot?.health ?? null,
    food: bot?.food ?? null,
    dimension: bot?.game?.dimension ?? null,
    position: pos
      ? { x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)), z: Number(pos.z.toFixed(2)) }
      : null,
    heldItem: bot?.heldItem
      ? { name: bot.heldItem.name, count: bot.heldItem.count }
      : null,
    inventory: inventorySnapshot(bot),
    timeOfDay: bot?.time?.timeOfDay ?? null,
    ...extras
  };
}

const grid = document.getElementById("grid");
const template = document.getElementById("bot-card");
const botCount = document.getElementById("bot-count");
const completionsCount = document.getElementById("completions-count");
const completionsGoal = document.getElementById("completions-goal");
const clock = document.getElementById("clock");
const refreshBtn = document.getElementById("refresh");

const cards = new Map();

function rewriteLocalUrl(url) {
  if (!url) return url;
  try {
    // Relative /viewer/N/ stays same-origin (works through a single FRP port).
    const parsed = new URL(url, window.location.origin);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function viewerLabel(viewerUrl, botId) {
  try {
    const parsed = new URL(viewerUrl, window.location.origin);
    if (parsed.pathname.startsWith("/viewer/")) {
      return `/viewer/${botId}`;
    }
    return parsed.port || "—";
  } catch {
    return "—";
  }
}

function fmtPos(pos) {
  if (!pos) return "—";
  return `${pos.x}, ${pos.y}, ${pos.z}`;
}

function ensureCard(bot) {
  let card = cards.get(bot.id);
  if (card) return card;

  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.id = String(bot.id);
  node.querySelector(".name").textContent = bot.username || `rl_bot_${bot.id}`;
  const iframe = node.querySelector(".viewer");
  // Prefer host from the page URL so LAN clients never hit another PC's 127.0.0.1
  const viewerUrl = rewriteLocalUrl(bot.viewerUrl);
  iframe.src = viewerUrl;
  node.querySelector(".open-view").href = viewerUrl;
  grid.appendChild(node);
  card = { node, iframe };
  cards.set(bot.id, card);
  return card;
}

function renderBot(bot) {
  const { node, iframe } = ensureCard(bot);
  const badge = node.querySelector(".badge");
  const sub = node.querySelector(".sub");
  const stats = node.querySelector(".stats");
  const inventory = node.querySelector(".inventory");
  const viewerUrl = rewriteLocalUrl(bot.viewerUrl);
  if (viewerUrl && iframe.src !== viewerUrl) {
    const current = iframe.src || "";
    // Migrate old direct :3000 URLs (or blank) onto the dashboard proxy path
    if (
      !current
      || current.includes("127.0.0.1")
      || current.includes("localhost")
      || /:\d{4,5}\/?$/.test(new URL(current).origin + "/")
      || !current.includes("/viewer/")
    ) {
      try {
        const want = new URL(viewerUrl, window.location.origin).href;
        if (iframe.src !== want) iframe.src = viewerUrl;
      } catch {
        iframe.src = viewerUrl;
      }
    }
  }
  node.querySelector(".open-view").href = viewerUrl;

  badge.textContent = bot.online ? "online" : "offline";
  badge.className = `badge ${bot.online ? "online" : "offline"}`;
  const viewHint = viewerLabel(viewerUrl, bot.id);
  sub.textContent = bot.online
    ? `stage ${bot.stage ?? "—"} · mc :${bot.mcPort ?? "—"} · view ${viewHint}`
    : bot.error || "bridge unreachable";

  const held = bot.heldItem ? `${bot.heldItem.name} ×${bot.heldItem.count}` : "empty hand";
  const goal = bot.stageGoal ?? "goal";
  stats.innerHTML = `
    <div>HP <strong>${bot.health ?? "—"}</strong></div>
    <div>Food <strong>${bot.food ?? "—"}</strong></div>
    <div>Pos <strong>${fmtPos(bot.position)}</strong></div>
    <div>Held <strong>${held}</strong></div>
    <div>Episode step <strong>${bot.episodeStep ?? "—"}</strong></div>
    <div>Resets <strong>${bot.episodeResets ?? "—"}</strong></div>
    <div class="stat-completions">Completions <strong>${bot.stageCompletions ?? 0}</strong> <span class="goal-hint">${goal}</span></div>
  `;

  inventory.innerHTML = "";
  const items = bot.inventory || [];
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No items";
    inventory.appendChild(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${item.displayName || item.name}</span><strong>×${item.count}</strong>`;
    inventory.appendChild(li);
  }
}

async function tick() {
  try {
    const response = await fetch("/api/bots");
    const data = await response.json();
    botCount.textContent = `${data.bots.length} bots`;
    clock.textContent = new Date(data.updatedAt).toLocaleTimeString();

    let totalCompletions = 0;
    const goals = new Set();
    for (const bot of data.bots) {
      totalCompletions += Number(bot.stageCompletions) || 0;
      if (bot.stageGoal) goals.add(bot.stageGoal);
      renderBot(bot);
    }
    completionsCount.textContent = String(totalCompletions);
    completionsGoal.textContent = goals.size ? `(${[...goals].join(", ")})` : "";
  } catch (error) {
    clock.textContent = `error: ${error.message}`;
  }
}

refreshBtn.addEventListener("click", () => {
  for (const { iframe } of cards.values()) {
    iframe.src = iframe.src;
  }
  tick();
});

tick();
setInterval(tick, 1500);

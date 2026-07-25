package com.rlbeats.recorder;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.GameOptions;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

public class DemoSession {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
	private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss");

	private static final String[] TRACKED_ITEMS = {
		"oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
		"dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log",
		"oak_planks", "crafting_table", "wooden_pickaxe", "cobblestone",
		"stone_pickaxe", "furnace", "raw_iron", "iron_ingot", "iron_pickaxe",
		"diamond", "diamond_pickaxe", "obsidian", "flint_and_steel",
		"blaze_rod", "ender_pearl", "ender_eye", "stick", "cobbled_deepslate"
	};

	private boolean recording;
	private Path path;
	private BufferedWriter writer;
	private int tick;
	private int stageHint = 6;
	private float lastYaw;
	private float lastPitch;
	private boolean haveLook;

	public boolean isRecording() {
		return recording;
	}

	public int getStageHint() {
		return stageHint;
	}

	public void setStageHint(int stageHint) {
		this.stageHint = Math.max(0, Math.min(19, stageHint));
	}

	public Path currentPath() {
		return path;
	}

	public int lastTickCount() {
		return tick;
	}

	public synchronized void start(MinecraftClient client) throws IOException {
		if (recording) {
			return;
		}
		Path dir = client.runDirectory.toPath().resolve("rl-demos");
		Files.createDirectories(dir);
		String name = "demo_" + LocalDateTime.now().format(STAMP) + ".jsonl";
		path = dir.resolve(name);
		writer = Files.newBufferedWriter(path, StandardCharsets.UTF_8);
		tick = 0;
		haveLook = false;
		recording = true;
	}

	public synchronized String stop() throws IOException {
		if (!recording) {
			return path == null ? "" : path.toString();
		}
		recording = false;
		if (writer != null) {
			writer.flush();
			writer.close();
			writer = null;
		}
		return path == null ? "" : path.toString();
	}

	public synchronized void tick(MinecraftClient client) {
		if (!recording || writer == null) {
			return;
		}
		ClientPlayerEntity player = client.player;
		if (player == null || client.options == null) {
			return;
		}
		try {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("t", tick);
			row.put("stage_hint", stageHint);

			GameOptions opt = client.options;
			Map<String, Object> keys = new LinkedHashMap<>();
			keys.put("forward", opt.forwardKey.isPressed());
			keys.put("back", opt.backKey.isPressed());
			keys.put("left", opt.leftKey.isPressed());
			keys.put("right", opt.rightKey.isPressed());
			keys.put("jump", opt.jumpKey.isPressed());
			keys.put("sneak", opt.sneakKey.isPressed());
			keys.put("sprint", opt.sprintKey.isPressed());
			keys.put("attack", opt.attackKey.isPressed());
			keys.put("use", opt.useKey.isPressed());
			keys.put("drop", opt.dropKey.isPressed());
			keys.put("swapHands", opt.swapHandsKey.isPressed());
			row.put("keys", keys);

			float yaw = player.getYaw();
			float pitch = player.getPitch();
			float dyaw = haveLook ? wrapDegrees(yaw - lastYaw) : 0f;
			float dpitch = haveLook ? (pitch - lastPitch) : 0f;
			lastYaw = yaw;
			lastPitch = pitch;
			haveLook = true;

			Map<String, Object> look = new LinkedHashMap<>();
			look.put("yaw", yaw);
			look.put("pitch", pitch);
			look.put("dyaw", dyaw);
			look.put("dpitch", dpitch);
			row.put("look", look);

			row.put("hotbar", player.getInventory().selectedSlot);
			row.put("onGround", player.isOnGround());
			row.put("health", player.getHealth());
			row.put("food", player.getHungerManager().getFoodLevel());
			row.put("dimension", player.getWorld().getRegistryKey().getValue().toString());

			Map<String, Object> pos = new LinkedHashMap<>();
			pos.put("x", player.getX());
			pos.put("y", player.getY());
			pos.put("z", player.getZ());
			row.put("pos", pos);

			row.put("inv", countInventory(player));
			row.put("screen", client.currentScreen == null ? null : client.currentScreen.getClass().getSimpleName());

			writer.write(GSON.toJson(row));
			writer.newLine();
			tick += 1;
			if (tick % 40 == 0) {
				writer.flush();
			}
		} catch (IOException e) {
			RlDemoRecorderClient.LOGGER.error("Demo write failed", e);
			try {
				stop();
			} catch (IOException ignored) {
			}
		}
	}

	private static Map<String, Integer> countInventory(ClientPlayerEntity player) {
		Map<String, Integer> counts = new LinkedHashMap<>();
		for (String name : TRACKED_ITEMS) {
			counts.put(name, 0);
		}
		for (int i = 0; i < player.getInventory().size(); i++) {
			ItemStack stack = player.getInventory().getStack(i);
			if (stack.isEmpty()) {
				continue;
			}
			Identifier id = Registries.ITEM.getId(stack.getItem());
			String name = id.getPath();
			if (counts.containsKey(name)) {
				counts.put(name, counts.get(name) + stack.getCount());
			} else if (name.endsWith("_planks")) {
				counts.put(name, counts.getOrDefault(name, 0) + stack.getCount());
			} else if (name.endsWith("_log") || name.endsWith("_stem")) {
				counts.put(name, counts.getOrDefault(name, 0) + stack.getCount());
			}
		}
		return counts;
	}

	private static float wrapDegrees(float degrees) {
		float d = degrees % 360f;
		if (d >= 180f) {
			d -= 360f;
		}
		if (d < -180f) {
			d += 360f;
		}
		return d;
	}
}

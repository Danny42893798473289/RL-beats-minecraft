package com.rlbeats.recorder;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class RlDemoRecorderClient implements ClientModInitializer {
	public static final String MOD_ID = "rl_demo_recorder";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private static KeyBinding toggleKey;
	private static final DemoSession SESSION = new DemoSession();

	@Override
	public void onInitializeClient() {
		toggleKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
			"key.rl_demo_recorder.toggle",
			InputUtil.Type.KEYSYM,
			GLFW.GLFW_KEY_R,
			"category.rl_demo_recorder"
		));

		ClientTickEvents.END_CLIENT_TICK.register(client -> {
			while (toggleKey.wasPressed()) {
				toggle(client);
			}
			if (SESSION.isRecording()) {
				SESSION.tick(client);
			}
		});

		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			dispatcher.register(ClientCommandManager.literal("rlrec")
				.then(ClientCommandManager.literal("start").executes(ctx -> {
					start(MinecraftClient.getInstance());
					return 1;
				}))
				.then(ClientCommandManager.literal("stop").executes(ctx -> {
					stop(MinecraftClient.getInstance());
					return 1;
				}))
				.then(ClientCommandManager.literal("status").executes(ctx -> {
					status(MinecraftClient.getInstance());
					return 1;
				}))
			);
			dispatcher.register(ClientCommandManager.literal("rlstage")
				.then(ClientCommandManager.argument("stage", IntegerArgumentType.integer(0, 19))
					.executes(ctx -> {
						int stage = IntegerArgumentType.getInteger(ctx, "stage");
						SESSION.setStageHint(stage);
						MinecraftClient client = MinecraftClient.getInstance();
						if (client.player != null) {
							client.player.sendMessage(Text.literal("[RL Demo] stage_hint=" + stage), false);
						}
						return 1;
					}))
			);
		});

		LOGGER.info("RL Demo Recorder ready (R to toggle, /rlrec start|stop|status, /rlstage <n>)");
	}

	private static void toggle(MinecraftClient client) {
		if (SESSION.isRecording()) {
			stop(client);
		} else {
			start(client);
		}
	}

	private static void start(MinecraftClient client) {
		try {
			SESSION.start(client);
			if (client.player != null) {
				client.player.sendMessage(
					Text.literal("[RL Demo] recording → " + SESSION.currentPath()),
					false
				);
			}
		} catch (Exception e) {
			LOGGER.error("Failed to start recording", e);
			if (client.player != null) {
				client.player.sendMessage(Text.literal("[RL Demo] start failed: " + e.getMessage()), false);
			}
		}
	}

	private static void stop(MinecraftClient client) {
		try {
			String path = SESSION.stop();
			if (client.player != null) {
				client.player.sendMessage(
					Text.literal("[RL Demo] stopped (" + SESSION.lastTickCount() + " ticks) → " + path),
					false
				);
			}
		} catch (Exception e) {
			LOGGER.error("Failed to stop recording", e);
			if (client.player != null) {
				client.player.sendMessage(Text.literal("[RL Demo] stop failed: " + e.getMessage()), false);
			}
		}
	}

	private static void status(MinecraftClient client) {
		if (client.player == null) {
			return;
		}
		if (SESSION.isRecording()) {
			client.player.sendMessage(
				Text.literal("[RL Demo] recording tick=" + SESSION.lastTickCount()
					+ " stage=" + SESSION.getStageHint()
					+ " file=" + SESSION.currentPath()),
				false
			);
		} else {
			client.player.sendMessage(Text.literal("[RL Demo] idle (press R or /rlrec start)"), false);
		}
	}
}

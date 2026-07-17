import json
import time
import uuid
from typing import Any

import gymnasium as gym
import numpy as np
import websocket
from websocket import WebSocketConnectionClosedException, WebSocketTimeoutException

# Must match bridge/src/skills.js: len(PRIMITIVES) + MAX_INVENTED
ACTION_SIZE = 52
OBSERVATION_SIZE = 64

_TRANSIENT = (
    WebSocketConnectionClosedException,
    WebSocketTimeoutException,
    OSError,
    ConnectionError,
    TimeoutError,
)


class MinecraftEnv(gym.Env[np.ndarray, int]):
    metadata = {"render_modes": []}

    def __init__(
        self,
        url: str = "ws://127.0.0.1:8765",
        stage: int = 1,
        connect_retries: int = 180,
        timeout: float = 360.0,
    ) -> None:
        super().__init__()
        self.url = url
        self.stage = stage
        self.connect_retries = connect_retries
        self.timeout = timeout
        self.ws: websocket.WebSocket | None = None
        self.action_space = gym.spaces.Discrete(ACTION_SIZE)
        self.observation_space = gym.spaces.Box(
            low=0.0, high=1.0, shape=(OBSERVATION_SIZE,), dtype=np.float32
        )
        self.last_info: dict[str, Any] = {}

    def _blank_obs(self) -> np.ndarray:
        return np.zeros(OBSERVATION_SIZE, dtype=np.float32)

    def _connect(self, *, force: bool = False, raise_on_fail: bool = True) -> bool:
        if self.ws is not None and not force:
            return True
        self.close()
        last_error: Exception | None = None
        for attempt in range(self.connect_retries):
            try:
                self.ws = websocket.create_connection(self.url, timeout=min(30.0, self.timeout))
                # Short timeout for ping during reconnect storms
                self.ws.settimeout(30.0)
                response = self._request("ping", _allow_reconnect=False, _retry_not_ready=False)
                if response.get("ready"):
                    self.ws.settimeout(self.timeout)
                    return True
                self.close()
            except Exception as error:
                last_error = error
                self.close()
            # Back off a bit while a crashed bridge / Paper wipe recovers
            time.sleep(1.0 if attempt < 30 else 2.0)
        if raise_on_fail:
            raise ConnectionError(f"bridge at {self.url} was not ready: {last_error}")
        return False

    def _request(
        self,
        message_type: str,
        *,
        _allow_reconnect: bool = True,
        _retry_not_ready: bool = True,
        **payload: Any,
    ) -> dict[str, Any]:
        if self.ws is None:
            self._connect()
        assert self.ws is not None
        request_id = uuid.uuid4().hex
        try:
            self.ws.send(json.dumps({"id": request_id, "type": message_type, **payload}))
            while True:
                response = json.loads(self.ws.recv())
                if response.get("id") != request_id:
                    continue
                if "error" in response:
                    error = str(response["error"])
                    if (
                        _retry_not_ready
                        and _allow_reconnect
                        and error in {"bot_not_ready", "bot_ready_timeout"}
                    ):
                        time.sleep(2)
                        self._connect(force=True)
                        return self._request(
                            message_type,
                            _allow_reconnect=False,
                            _retry_not_ready=False,
                            **payload,
                        )
                    raise RuntimeError(error)
                return response
        except _TRANSIENT:
            self.close()
            if not _allow_reconnect:
                raise
            # Bridge crash / wipe: wait for process restart, then retry once.
            if not self._connect(force=True, raise_on_fail=False):
                raise ConnectionError(f"bridge at {self.url} stayed down after disconnect")
            return self._request(
                message_type,
                _allow_reconnect=False,
                _retry_not_ready=_retry_not_ready,
                **payload,
            )

    @staticmethod
    def _observation(response: dict[str, Any]) -> np.ndarray:
        observation = np.asarray(response["observation"], dtype=np.float32)
        if observation.shape != (OBSERVATION_SIZE,):
            raise ValueError(f"invalid observation shape: {observation.shape}")
        return np.clip(observation, 0.0, 1.0)

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        selected_stage = int((options or {}).get("stage", self.stage))
        try:
            self._connect(force=True)
            if self.ws is not None:
                self.ws.settimeout(max(self.timeout, 360.0))
            response = self._request("reset", stage=selected_stage, seed=seed)
            self.last_info = response.get("info", {})
            return self._observation(response), self.last_info
        except Exception as error:
            # Keep SubprocVecEnv alive if one bridge is briefly dead
            self.last_info = {"bridge_error": str(error), "reset_failed": True}
            return self._blank_obs(), self.last_info

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        try:
            response = self._request("step", action=int(action))
            self.last_info = response.get("info", {})
            return (
                self._observation(response),
                float(response["reward"]),
                bool(response["terminated"]),
                bool(response["truncated"]),
                self.last_info,
            )
        except Exception as error:
            # Truncate episode instead of killing the training worker
            self.last_info = {"bridge_error": str(error), "step_failed": True}
            return self._blank_obs(), -1.0, False, True, self.last_info

    def list_invented_skills(self) -> list[dict[str, Any]]:
        self._connect()
        response = self._request("skills")
        return list(response.get("invented", []))

    def close(self) -> None:
        if self.ws is not None:
            try:
                self.ws.close()
            finally:
                self.ws = None

"""Loopback OSWorld bridge owned by the Stage 5 runner.

The process owns one persistent DesktopEnv.  The TypeScript side only sees a
small JSON RPC surface; task evaluators and VM lifecycle never enter the
Harness model context.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import math
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Lock, Thread
from typing import Any


LOGGER = logging.getLogger("computer_harness.osworld_bridge")
PROTOCOL_VERSION = "1"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class DesktopEnvBridge:
    def __init__(self, args: argparse.Namespace) -> None:
        osworld_root = Path(args.osworld_root).expanduser().resolve()
        if not osworld_root.is_dir():
            raise BridgeError("CONFIG_ERROR", f"OSWorld root does not exist: {osworld_root}")
        sys.path.insert(0, str(osworld_root))
        try:
            from desktop_env.desktop_env import DesktopEnv
        except Exception as exc:  # pragma: no cover - depends on the external OSWorld environment
            raise BridgeError("IMPORT_ERROR", f"could not import OSWorld DesktopEnv: {exc}") from exc

        self._args = args
        self._env: Any | None = None
        self._task_id: str | None = None
        self._instruction: str | None = None
        self._initial_capture: dict[str, Any] | None = None
        self._viewport: tuple[int, int] | None = None
        self._closed = False
        self._lock = Lock()

        # DesktopEnv starts and owns the VM.  It is created once for the bridge
        # process and reset() switches tasks without creating a second owner.
        self._env = DesktopEnv(
            provider_name=args.provider,
            path_to_vm=args.path_to_vm,
            snapshot_name=args.snapshot_name,
            # The bridge emits structured action_type/parameters dictionaries;
            # OSWorld's computer_13 path is the consumer for that shape.
            action_space="computer_13",
            cache_dir=args.cache_dir,
            screen_size=(args.screen_width, args.screen_height),
            headless=args.headless,
            require_a11y_tree=False,
            require_terminal=False,
            os_type=args.os_type,
            enable_proxy=args.enable_proxy,
        )

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "protocolVersion": PROTOCOL_VERSION,
            "osworldVersion": str(self._args.osworld_version),
        }

    def reset(self, task_id: str) -> dict[str, str]:
        if not isinstance(task_id, str) or not task_id.strip():
            raise BridgeError("INVALID_ARGUMENT", "taskId must be a non-empty string")
        task = self._load_task(task_id)
        env = self._require_env()
        self._task_id = None
        self._instruction = None
        self._initial_capture = None
        self._viewport = None
        observation = env.reset(task_config=task)
        screenshot = observation.get("screenshot")
        self._initial_capture = self._capture(screenshot)
        self._viewport = (self._initial_capture["width"], self._initial_capture["height"])
        self._task_id = task_id
        self._instruction = task["instruction"]
        return {"taskId": task_id, "instruction": self._instruction}

    def describe(self) -> dict[str, Any]:
        viewport = self._viewport
        if viewport is None:
            raise BridgeError("NO_TASK", "reset a task before describing the computer")
        return {
            "viewport": {
                "width": viewport[0],
                "height": viewport[1],
                "coordinateSpace": "physical",
            },
            "capabilities": {"screenshot": True, "pointer": True, "keyboard": True},
        }

    def observe(self) -> dict[str, Any]:
        initial = self._initial_capture
        if initial is not None:
            self._initial_capture = None
            return initial
        env = self._require_task_env()
        return self._capture(env._get_obs().get("screenshot"))

    def execute(self, action: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(action, dict):
            raise BridgeError("INVALID_ARGUMENT", "action must be an object")
        env = self._require_task_env()
        try:
            typed = self._validate_typed_action(action)
        except BridgeError as exc:
            # Schema failures happen before DesktopEnv.step() and therefore
            # are safe, explicit refusals rather than uncertain side effects.
            return {"status": "refused", "code": exc.code, "message": str(exc)}
        try:
            capture = self._execute_typed(env, typed)
        except BridgeError:
            raise
        except Exception as exc:
            # A transport-level caller cannot know whether the guest accepted
            # a side effect.  The TypeScript adapter will propagate this as an
            # uncertain execution rather than fabricate a failed receipt.
            raise BridgeError("EXECUTION_ERROR", str(exc)) from exc
        return {"status": "completed", "postActionCapture": self._capture(capture)}

    def evaluate(self) -> dict[str, Any]:
        env = self._require_task_env()
        try:
            score = env.evaluate()
        except Exception as exc:
            raise BridgeError("EVALUATION_ERROR", str(exc)) from exc
        if not isinstance(score, (int, float)) or not math.isfinite(float(score)):
            raise BridgeError("INVALID_RESULT", "OSWorld evaluator returned a non-finite score")
        return {"score": float(score)}

    def close(self) -> dict[str, bool]:
        if not self._closed:
            env = self._env
            self._env = None
            self._closed = True
            self._task_id = None
            self._instruction = None
            self._initial_capture = None
            self._viewport = None
            if env is not None:
                env.close()
        return {"closed": True}

    def _require_env(self) -> Any:
        if self._closed or self._env is None:
            raise BridgeError("CLOSED", "OSWorld bridge is closed")
        return self._env

    def _require_task_env(self) -> Any:
        if self._task_id is None:
            raise BridgeError("NO_TASK", "reset a task before using the computer")
        return self._require_env()

    def _load_task(self, task_id: str) -> dict[str, Any]:
        root = Path(self._args.osworld_root).expanduser().resolve() / "evaluation_examples" / "examples"
        matches = sorted(root.rglob(f"{task_id}.json"))
        if len(matches) == 0:
            raise BridgeError("TASK_NOT_FOUND", f"OSWorld task was not found: {task_id}")
        if len(matches) > 1:
            raise BridgeError("TASK_NOT_UNIQUE", f"OSWorld task ID matched multiple files: {task_id}")
        try:
            value = json.loads(matches[0].read_text(encoding="utf-8"))
        except Exception as exc:
            raise BridgeError("TASK_INVALID", f"could not read task {task_id}: {exc}") from exc
        if not isinstance(value, dict) or value.get("id") != task_id or not isinstance(value.get("instruction"), str):
            raise BridgeError("TASK_INVALID", f"task {task_id} has an invalid instruction")
        return value

    def _capture(self, screenshot: Any) -> dict[str, Any]:
        if not isinstance(screenshot, (bytes, bytearray)) or not screenshot:
            raise BridgeError("SCREENSHOT_ERROR", "OSWorld did not return screenshot bytes")
        payload = bytes(screenshot)
        width, height = png_dimensions(payload)
        return {
            "mediaType": "image/png",
            "dataBase64": base64.b64encode(payload).decode("ascii"),
            "width": width,
            "height": height,
            "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }

    def _validate_typed_action(self, action: dict[str, Any]) -> dict[str, Any]:
        kind = action.get("kind")
        if kind not in {"click", "double_click", "right_click", "type", "keypress", "hotkey", "scroll", "drag", "wait"}:
            raise BridgeError("INVALID_ACTION", f"unsupported action kind: {kind!r}")
        if kind in {"click", "double_click", "right_click", "scroll"}:
            require_finite_number(action, "x")
            require_finite_number(action, "y")
            self._check_point(action["x"], action["y"], kind)
        if kind == "drag":
            for key in ("fromX", "fromY", "toX", "toY"):
                require_finite_number(action, key)
            self._check_point(action["fromX"], action["fromY"], "drag.from")
            self._check_point(action["toX"], action["toY"], "drag.to")
        if kind == "type" and not isinstance(action.get("text"), str):
            raise BridgeError("INVALID_ACTION", "type.text must be a string")
        normalized = dict(action)
        if kind in {"keypress", "hotkey"}:
            if kind == "keypress" and not isinstance(action.get("key"), str):
                raise BridgeError("INVALID_ACTION", "keypress.key must be a string")
            if kind == "keypress" and isinstance(action.get("key"), str):
                normalized["key"] = action["key"].lower()
            if kind == "hotkey" and (not isinstance(action.get("keys"), list) or not action["keys"] or any(not isinstance(key, str) or not key for key in action["keys"])):
                raise BridgeError("INVALID_ACTION", "hotkey.keys must be a non-empty string list")
            if kind == "hotkey":
                normalized["keys"] = [key.lower() for key in action["keys"]]
        if kind == "scroll":
            if action.get("direction") not in {"up", "down", "left", "right"} or not positive_integer(action.get("ticks")):
                raise BridgeError("INVALID_ACTION", "scroll direction/ticks are invalid")
        if kind == "wait" and (not isinstance(action.get("durationMs"), (int, float)) or not math.isfinite(float(action["durationMs"])) or action["durationMs"] < 0):
            raise BridgeError("INVALID_ACTION", "wait.durationMs must be a non-negative number")
        return normalized

    def _check_point(self, x: float, y: float, label: str) -> None:
        viewport = self._viewport
        if viewport is None or x < 0 or x >= viewport[0] or y < 0 or y >= viewport[1]:
            raise BridgeError("INVALID_ACTION", f"{label} point is outside the OSWorld viewport")

    def _execute_typed(self, env: Any, action: dict[str, Any]) -> bytes:
        kind = action["kind"]
        if kind == "click":
            return self._step(env, {"action_type": "CLICK", "parameters": {"x": action["x"], "y": action["y"], "button": "left"}})
        if kind == "double_click":
            return self._step(env, {"action_type": "DOUBLE_CLICK", "parameters": {"x": action["x"], "y": action["y"]}})
        if kind == "right_click":
            return self._step(env, {"action_type": "RIGHT_CLICK", "parameters": {"x": action["x"], "y": action["y"]}})
        if kind == "type":
            return self._step(env, {"action_type": "TYPING", "parameters": {"text": action["text"]}})
        if kind == "keypress":
            return self._step(env, {"action_type": "PRESS", "parameters": {"key": action["key"]}})
        if kind == "hotkey":
            return self._step(env, {"action_type": "HOTKEY", "parameters": {"keys": action["keys"]}})
        if kind == "scroll":
            self._step(env, {"action_type": "MOVE_TO", "parameters": {"x": action["x"], "y": action["y"]}}, pause=0)
            dx, dy = 0, 0
            if action["direction"] == "left": dx = -action["ticks"]
            if action["direction"] == "right": dx = action["ticks"]
            if action["direction"] == "up": dy = action["ticks"]
            if action["direction"] == "down": dy = -action["ticks"]
            return self._step(env, {"action_type": "SCROLL", "parameters": {"dx": dx, "dy": dy}})
        if kind == "drag":
            self._step(env, {"action_type": "MOVE_TO", "parameters": {"x": action["fromX"], "y": action["fromY"]}}, pause=0)
            return self._step(env, {"action_type": "DRAG_TO", "parameters": {"x": action["toX"], "y": action["toY"]}})
        if kind == "wait":
            self._step(env, "WAIT", pause=0)
            time.sleep(float(action["durationMs"]) / 1000)
            return env._get_obs().get("screenshot")
        raise BridgeError("INVALID_ACTION", f"unsupported action kind: {kind!r}")

    def _step(self, env: Any, action: Any, pause: float | None = None) -> bytes:
        kwargs = {} if pause is None else {"pause": pause}
        observation, _reward, _done, _info = env.step(action, **kwargs)
        screenshot = observation.get("screenshot") if isinstance(observation, dict) else None
        if not isinstance(screenshot, (bytes, bytearray)) or not screenshot:
            raise BridgeError("SCREENSHOT_ERROR", "OSWorld step did not return screenshot bytes")
        return bytes(screenshot)


def require_finite_number(value: dict[str, Any], key: str) -> None:
    number = value.get(key)
    if not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(float(number)):
        raise BridgeError("INVALID_ACTION", f"{key} must be a finite number")


def positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise BridgeError("SCREENSHOT_ERROR", "OSWorld screenshot is not a valid PNG")
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    if width <= 0 or height <= 0:
        raise BridgeError("SCREENSHOT_ERROR", "OSWorld screenshot has invalid dimensions")
    return width, height


class RpcHandler(BaseHTTPRequestHandler):
    service: DesktopEnvBridge
    token: str

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/rpc":
            self._write_error("NOT_FOUND", "RPC endpoint not found", 404)
            return
        if self.token and self.headers.get("Authorization") != f"Bearer {self.token}":
            self._write_error("UNAUTHORIZED", "invalid bridge token", 401)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4 * 1024 * 1024:
                raise BridgeError("INVALID_REQUEST", "request body size is invalid")
            request = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(request, dict) or not isinstance(request.get("requestId"), str) or not request["requestId"] or not isinstance(request.get("method"), str):
                raise BridgeError("INVALID_REQUEST", "requestId and method are required")
            request_id = request["requestId"]
            result = self._dispatch(request["method"], request.get("params", {}))
            self._write_json({"requestId": request_id, "ok": True, "result": result})
        except BridgeError as exc:
            request_id = request.get("requestId", "") if isinstance(locals().get("request"), dict) else ""
            self._write_json({"requestId": request_id, "ok": False, "error": {"code": exc.code, "message": str(exc)}}, 400)
        except Exception as exc:  # pragma: no cover - external DesktopEnv errors
            LOGGER.exception("unhandled bridge request error")
            request_id = request.get("requestId", "") if isinstance(locals().get("request"), dict) else ""
            self._write_json({"requestId": request_id, "ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(exc)}}, 500)

    def _dispatch(self, method: str, params: Any) -> Any:
        if not isinstance(params, dict):
            raise BridgeError("INVALID_REQUEST", "params must be an object")
        with self.service._lock:
            if method == "health": return self.service.health()
            if method == "environment.reset": return self.service.reset(params.get("taskId"))
            if method == "computer.describe": return self.service.describe()
            if method == "computer.observe": return self.service.observe()
            if method == "computer.execute": return self.service.execute(params.get("action"))
            if method == "environment.evaluate": return self.service.evaluate()
            if method == "environment.close": return self.service.close()
        raise BridgeError("UNKNOWN_METHOD", f"unsupported RPC method: {method}")

    def _write_error(self, code: str, message: str, status: int) -> None:
        self._write_json({"requestId": "", "ok": False, "error": {"code": code, "message": message}}, status)

    def _write_json(self, value: dict[str, Any], status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s", format % args)


class ReusableHttpServer(HTTPServer):
    allow_reuse_address = True


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local OSWorld DesktopEnv bridge")
    parser.add_argument("--osworld-root", required=True)
    parser.add_argument("--path-to-vm", required=True)
    parser.add_argument("--vmrun-path", default="")
    parser.add_argument("--provider", default="vmware")
    parser.add_argument("--snapshot-name", default="init_state")
    parser.add_argument("--cache-dir", default="cache")
    parser.add_argument("--os-type", default="Ubuntu")
    parser.add_argument("--screen-width", type=int, default=1920)
    parser.add_argument("--screen-height", type=int, default=1080)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--enable-proxy", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--osworld-version", default="unknown")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)
    if args.host != "127.0.0.1":
        raise SystemExit("OSWorld bridge only permits loopback host 127.0.0.1")
    if args.vmrun_path:
        vmrun = Path(args.vmrun_path).expanduser().resolve()
        if not vmrun.is_file():
            raise SystemExit(f"vmrun executable does not exist: {vmrun}")
        os.environ["PATH"] = str(vmrun.parent) + os.pathsep + os.environ.get("PATH", "")
    args.token = os.environ.get("OSWORLD_BRIDGE_TOKEN", "")
    service = DesktopEnvBridge(args)
    handler = type("BoundRpcHandler", (RpcHandler,), {"service": service, "token": args.token})
    server = ReusableHttpServer((args.host, args.port), handler)
    LOGGER.info("OSWorld bridge listening on %s:%s", args.host, server.server_port)
    print(f"READY {server.server_port}", flush=True)

    def stop(_signum: int, _frame: Any) -> None:
        try:
            service.close()
        finally:
            # HTTPServer.shutdown() must run outside serve_forever()'s thread.
            Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        service.close()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

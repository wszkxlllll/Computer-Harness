import argparse
import base64
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
PNG_2X1 = bytearray(PNG_1X1)
PNG_2X1[19] = 2


class FakeDesktopEnv:
    instance = None

    def __init__(self, **kwargs):
        self.options = kwargs
        self.steps = []
        self.closed = False
        self.fail_step = False
        self.next_screenshot = None
        FakeDesktopEnv.instance = self

    def reset(self, task_config):
        self.task_config = task_config
        return {"screenshot": PNG_1X1}

    def _get_obs(self):
        return {"screenshot": self.next_screenshot or PNG_1X1}

    def step(self, action, pause=2):
        self.steps.append((action, pause))
        if self.fail_step:
            raise RuntimeError("fake guest disconnected after dispatch")
        return self._get_obs(), 0, False, {}

    def evaluate(self):
        return 1.0

    def close(self):
        self.closed = True


class BridgeContractTest(unittest.TestCase):
    def setUp(self):
        desktop_env = types.ModuleType("desktop_env")
        desktop_env_module = types.ModuleType("desktop_env.desktop_env")
        actions_module = types.ModuleType("desktop_env.actions")
        desktop_env_module.DesktopEnv = FakeDesktopEnv
        actions_module.KEYBOARD_KEYS = ["ctrl", "a", "enter", "shift", "down", "l"]
        desktop_env.desktop_env = desktop_env_module
        desktop_env.actions = actions_module
        sys.modules["desktop_env"] = desktop_env
        sys.modules["desktop_env.desktop_env"] = desktop_env_module
        sys.modules["desktop_env.actions"] = actions_module
        sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

    def tearDown(self):
        sys.modules.pop("desktop_env.desktop_env", None)
        sys.modules.pop("desktop_env.actions", None)
        sys.modules.pop("desktop_env", None)

    def test_structured_action_routing_and_keyboard_normalization(self):
        from integrations.osworld.bridge import DesktopEnvBridge

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "evaluation_examples" / "examples" / "fake"
            task_dir.mkdir(parents=True)
            (task_dir / "fake-task.json").write_text(
                json.dumps({"id": "fake-task", "instruction": "fake instruction"}),
                encoding="utf-8",
            )
            args = argparse.Namespace(
                osworld_root=str(root),
                provider="fake",
                path_to_vm="fake.vmx",
                snapshot_name="init_state",
                cache_dir=str(root / "cache"),
                screen_width=1,
                screen_height=1,
                headless=True,
                os_type="Ubuntu",
                enable_proxy=False,
                osworld_version="test",
            )
            service = DesktopEnvBridge(args)
            self.assertEqual(service.reset("fake-task")["instruction"], "fake instruction")
            self.assertEqual(service.describe()["viewport"], {"width": 1, "height": 1, "coordinateSpace": "physical"})
            self.assertIn("ctrl", service.describe()["capabilities"]["keyboardKeys"])
            service.observe()
            service.execute({"kind": "click", "x": 0, "y": 0})
            service.execute({"kind": "type", "text": "hello"})
            service.execute({"kind": "keypress", "key": "CTRL"})
            service.execute({"kind": "hotkey", "keys": ["CTRL", "L"]})
            service.execute({"kind": "scroll", "x": 0, "y": 0, "direction": "down", "ticks": 2})
            service.execute({"kind": "drag", "fromX": 0, "fromY": 0, "toX": 0, "toY": 0})
            service.execute({"kind": "wait", "durationMs": 0})
            self.assertEqual(FakeDesktopEnv.instance.options["action_space"], "computer_13")
            actions = [step[0] for step in FakeDesktopEnv.instance.steps]
            self.assertEqual(actions[0]["action_type"], "CLICK")
            self.assertEqual(actions[2], {"action_type": "PRESS", "parameters": {"key": "ctrl"}})
            self.assertEqual(actions[3], {"action_type": "HOTKEY", "parameters": {"keys": ["ctrl", "l"]}})
            self.assertEqual(actions[-1], "WAIT")
            self.assertEqual(service.evaluate(), {"score": 1.0})
            self.assertEqual(service.close(), {"closed": True})
            self.assertTrue(FakeDesktopEnv.instance.closed)

    def test_invalid_action_is_refused_before_desktop_step(self):
        from integrations.osworld.bridge import DesktopEnvBridge

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "evaluation_examples" / "examples" / "fake"
            task_dir.mkdir(parents=True)
            (task_dir / "fake-task.json").write_text(json.dumps({"id": "fake-task", "instruction": "fake"}), encoding="utf-8")
            args = argparse.Namespace(
                osworld_root=str(root), provider="fake", path_to_vm="fake.vmx", snapshot_name="init_state",
                cache_dir=str(root / "cache"), screen_width=1, screen_height=1, headless=True,
                os_type="Ubuntu", enable_proxy=False, osworld_version="test",
            )
            service = DesktopEnvBridge(args)
            service.reset("fake-task")
            service.observe()
            result = service.execute({"kind": "click", "x": 1, "y": 0})
            self.assertEqual(result["status"], "refused")
            self.assertEqual(FakeDesktopEnv.instance.steps, [])

    def test_unsupported_key_is_refused_before_desktop_step(self):
        from integrations.osworld.bridge import DesktopEnvBridge

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "evaluation_examples" / "examples" / "fake"
            task_dir.mkdir(parents=True)
            (task_dir / "fake-task.json").write_text(json.dumps({"id": "fake-task", "instruction": "fake"}), encoding="utf-8")
            args = argparse.Namespace(
                osworld_root=str(root), provider="fake", path_to_vm="fake.vmx", snapshot_name="init_state",
                cache_dir=str(root / "cache"), screen_width=1, screen_height=1, headless=True,
                os_type="Ubuntu", enable_proxy=False, osworld_version="test",
            )
            service = DesktopEnvBridge(args)
            service.reset("fake-task")
            result = service.execute({"kind": "keypress", "key": "MENU"})
            self.assertEqual(result["status"], "refused")
            self.assertEqual(result["code"], "UNSUPPORTED_KEY")
            self.assertEqual(FakeDesktopEnv.instance.steps, [])

    def test_step_exception_is_reported_as_execution_error(self):
        from integrations.osworld.bridge import BridgeError, DesktopEnvBridge

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "evaluation_examples" / "examples" / "fake"
            task_dir.mkdir(parents=True)
            (task_dir / "fake-task.json").write_text(json.dumps({"id": "fake-task", "instruction": "fake"}), encoding="utf-8")
            args = argparse.Namespace(
                osworld_root=str(root), provider="fake", path_to_vm="fake.vmx", snapshot_name="init_state",
                cache_dir=str(root / "cache"), screen_width=1, screen_height=1, headless=True,
                os_type="Ubuntu", enable_proxy=False, osworld_version="test",
            )
            service = DesktopEnvBridge(args)
            service.reset("fake-task")
            service.observe()
            FakeDesktopEnv.instance.fail_step = True
            with self.assertRaises(BridgeError) as raised:
                service.execute({"kind": "click", "x": 0, "y": 0})
            self.assertEqual(raised.exception.code, "EXECUTION_ERROR")

    def test_screenshot_viewport_change_updates_current_viewport_after_completion(self):
        from integrations.osworld.bridge import BridgeError, DesktopEnvBridge

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "evaluation_examples" / "examples" / "fake"
            task_dir.mkdir(parents=True)
            (task_dir / "fake-task.json").write_text(json.dumps({"id": "fake-task", "instruction": "fake"}), encoding="utf-8")
            args = argparse.Namespace(
                osworld_root=str(root), provider="fake", path_to_vm="fake.vmx", snapshot_name="init_state",
                cache_dir=str(root / "cache"), screen_width=1, screen_height=1, headless=True,
                os_type="Ubuntu", enable_proxy=False, osworld_version="test",
            )
            service = DesktopEnvBridge(args)
            service.reset("fake-task")
            service.observe()
            FakeDesktopEnv.instance.next_screenshot = bytes(PNG_2X1)
            result = service.execute({"kind": "click", "x": 0, "y": 0})
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["postActionCapture"]["width"], 2)
            self.assertEqual(service.describe()["viewport"], {"width": 2, "height": 1, "coordinateSpace": "physical"})
            self.assertEqual(len(FakeDesktopEnv.instance.steps), 1)


if __name__ == "__main__":
    unittest.main()

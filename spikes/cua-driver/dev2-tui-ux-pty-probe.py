"""Bounded real-winpty UX probe for the no-goal TUI home screen.

This probe deliberately never submits a goal.  It starts the production CLI
with the real winpty backend, writes only synthetic text, exercises resize and
the two home-screen exit paths, and writes raw terminal output only below the
caller-provided ignored run directory.
"""

import json
import os
import select
import sys
import time
from pathlib import Path

from winpty import PtyProcess

try:
    import psutil
except ImportError:  # CPU sampling is supplementary, not a probe prerequisite.
    psutil = None


INITIAL_SIZE = (24, 80)
RESIZED_SIZE = (30, 100)
CHINESE_INPUT = "受控中文粘贴测试"
TAIL_MARKER = "TAIL-END-9f1c"
LONG_INPUT = ("LONG-INPUT-" + ("0123456789abcdef" * 28) + TAIL_MARKER + ("OVERFLOW-" * 8))


def collect(pty: PtyProcess, seconds: float) -> str:
    chunks = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        remaining = max(0.0, deadline - time.time())
        try:
            ready, _, _ = select.select([pty.fileobj], [], [], min(0.1, remaining))
        except (OSError, ValueError):
            break
        if not ready:
            continue
        try:
            value = pty.read(8192)
        except EOFError:
            break
        if value:
            chunks.append(value)
    return "".join(chunks)


def write_count(pty: PtyProcess, value: str) -> int:
    try:
        return int(pty.pty.write(value))
    except (OSError, EOFError):
        return 0


def write_text(pty: PtyProcess, value: str) -> bool:
    return write_count(pty, value) > 0


def write_chunked(pty: PtyProcess, value: str, chunk_size: int = 32) -> tuple[bool, str, int]:
    """Feed a paste in bounded chunks so keypress dispatch can drain."""
    output = []
    succeeded = True
    bytes_written = 0
    for offset in range(0, len(value), chunk_size):
        written = write_count(pty, value[offset : offset + chunk_size])
        bytes_written += written
        succeeded = written > 0 and succeeded
        output.append(collect(pty, 0.08))
    output.append(collect(pty, 0.8))
    return succeeded, "".join(output), bytes_written


def separator_width(text: str) -> int:
    return max((line.count("\u2500") for line in text.splitlines()), default=0)


def safe_isatty(pty: PtyProcess) -> bool:
    try:
        return bool(pty.isatty())
    except (AttributeError, OSError):
        return False


def cpu_snapshot(pid: int | None) -> dict | None:
    if pid is None or psutil is None:
        return None
    try:
        times = psutil.Process(pid).cpu_times()
        return {"user": float(times.user), "system": float(times.system)}
    except (psutil.Error, OSError, ValueError):
        return None


def run_case(repo: str, node: str, output_root: Path, input_mode: str, exit_mode: str) -> dict:
    case_dir = output_root / f"{input_mode}-{exit_mode}"
    case_dir.mkdir(parents=True, exist_ok=True)
    safe_env = dict(os.environ)
    safe_env["PATH"] = os.path.dirname(node) + os.pathsep + safe_env.get("PATH", "")
    # Do not load a dotenv file and do not pass provider or bridge credentials
    # into this no-goal home-screen check.
    for key in (
        "ZHIPUAI_API_KEY",
        "ZHIPU_API_KEY",
        "GLM_API_KEY",
        "DASHSCOPE_API_KEY",
        "OSWORLD_BRIDGE_TOKEN",
    ):
        safe_env.pop(key, None)
    safe_env["PYWINPTY_BLOCK"] = "0"

    argv = [
        node,
        os.path.join("apps", "cli", "dist", "index.js"),
        "--tui",
        "--model",
        "glm-5.3-flash",
        "--computer",
        "osworld",
        "--osworld-bridge",
        "http://127.0.0.1:9",
        "--profile",
        "live-interactive",
        "--risk-guard",
        "layered",
        "--risk-model",
        "off",
        "--max-steps",
        "1",
        "--max-model-requests",
        "1",
        "--risk-max-model-requests",
        "1",
        "--output",
        str(case_dir),
    ]
    pty = None
    transcript = []
    forced = False
    resize_error = None
    pty_isatty = False
    child_pid = None
    cpu_start = None
    cpu_after_input = None
    input_write_return = 0
    input_write_duration_ms = 0.0
    drain_wait_ms = 0.0
    drain_complete_by_marker = False
    alive_after_input_drain = False
    try:
        pty = PtyProcess.spawn(argv, cwd=repo, env=safe_env, dimensions=INITIAL_SIZE)
        child_pid = int(pty.pid)
        pty_isatty = safe_isatty(pty)
        cpu_start = cpu_snapshot(child_pid)
        initial = collect(pty, 1.5)
        transcript.append(initial)

        chinese_write_ok = write_text(pty, CHINESE_INPUT)
        after_chinese = collect(pty, 0.8)
        transcript.append(after_chinese)

        try:
            pty.setwinsize(*RESIZED_SIZE)
        except Exception as error:  # pywinpty exposes backend-specific errors
            resize_error = type(error).__name__
        after_resize = collect(pty, 0.8)
        transcript.append(after_resize)

        write_started = time.perf_counter()
        if input_mode == "rapid":
            input_write_return = write_count(pty, LONG_INPUT)
            long_write_ok = input_write_return > 0
            after_long = collect(pty, 1.0)
        else:
            long_write_ok, after_long, input_write_return = write_chunked(pty, LONG_INPUT)
        input_write_duration_ms = (time.perf_counter() - write_started) * 1000.0
        # Rendering each keypress is deliberately observable; allow the
        # bounded PTY queue to drain before sending an exit control key.
        drain_started = time.perf_counter()
        for _ in range(12):
            if "Input is limited to 500 characters" in after_long or "Input limit reached (500 characters)" in after_long:
                drain_complete_by_marker = True
                break
            after_long += collect(pty, 0.5)
        drain_wait_ms = (time.perf_counter() - drain_started) * 1000.0
        alive_after_input_drain = pty.isalive()
        cpu_after_input = cpu_snapshot(child_pid)
        transcript.append(after_long)

        escape_write_ok = False
        quit_write_ok = False
        ctrl_c_write_ok = False
        if exit_mode == "esc-q":
            escape_write_ok = write_text(pty, "\x1b")
            after_escape = collect(pty, 1.0)
            transcript.append(after_escape)
            quit_write_ok = write_text(pty, "q")
        else:
            after_escape = ""
            ctrl_c_write_ok = write_text(pty, "\x03")

        final = collect(pty, 2.0)
        transcript.append(final)
        deadline = time.time() + 2.0
        while pty.isalive() and time.time() < deadline:
            transcript.append(collect(pty, 0.2))
        if pty.isalive():
            # Cleanup is bounded to this child only; a forced close is a
            # failure signal, never a success fallback.
            write_text(pty, "\x03")
            transcript.append(collect(pty, 0.8))
        if pty.isalive():
            forced = True
            pty.close(force=True)

        all_text = "".join(transcript)
        cpu_user_delta = None if cpu_start is None or cpu_after_input is None else cpu_after_input["user"] - cpu_start["user"]
        cpu_system_delta = None if cpu_start is None or cpu_after_input is None else cpu_after_input["system"] - cpu_start["system"]
        metrics = {
            "backend": "pywinpty-winpty",
            "input_mode": input_mode,
            "exit_mode": exit_mode,
            "child_pid": child_pid,
            "command_has_goal_flag": "--goal" in argv,
            "command_has_env_file_flag": "--env-file" in argv,
            "computer_mode": "osworld",
            "no_goal_home_only": "--goal" not in argv and "Computer Harness TUI  |  HOME" in all_text,
            "wrapper_isatty": pty_isatty,
            "initial_size": list(INITIAL_SIZE),
            "requested_resize": list(RESIZED_SIZE),
            "final_size_reported_by_pty": list(pty.getwinsize()),
            "initial_separator_width": separator_width(initial),
            "after_resize_separator_width": separator_width(after_resize),
            "after_long_separator_width": separator_width(after_long),
            "chinese_input_length": len(CHINESE_INPUT),
            "chinese_write_ok": chinese_write_ok,
            "chinese_visible_after_paste": CHINESE_INPUT in after_chinese,
            "long_input_length": len(LONG_INPUT),
            "long_write_ok": long_write_ok,
            "long_write_return": input_write_return,
            "long_write_duration_ms": round(input_write_duration_ms, 1),
            "drain_wait_ms": round(drain_wait_ms, 1),
            "drain_complete_by_limit_notice": drain_complete_by_marker,
            "alive_after_input_drain": alive_after_input_drain,
            "cpu_sample_supported": cpu_start is not None and cpu_after_input is not None,
            "cpu_user_delta_s": None if cpu_user_delta is None else round(cpu_user_delta, 4),
            "cpu_system_delta_s": None if cpu_system_delta is None else round(cpu_system_delta, 4),
            "cpu_total_delta_s": None if cpu_user_delta is None or cpu_system_delta is None else round(cpu_user_delta + cpu_system_delta, 4),
            "tail_marker_visible_after_long_input": TAIL_MARKER in after_long,
            "input_limit_notice_visible": "Input is limited to 500 characters" in after_long or "Input limit reached (500 characters)" in after_long,
            "full_long_input_echoed": LONG_INPUT in all_text,
            "resize_error_type": resize_error,
            "escape_write_ok": escape_write_ok,
            "escape_left_home_edit_mode": exit_mode != "esc-q" or "Keys: I/Enter edit   Esc/Q exit" in after_escape,
            "quit_write_ok": quit_write_ok,
            "ctrl_c_write_ok": ctrl_c_write_ok,
            "model_request_visible": "model.request.started" in all_text or "model.response.received" in all_text,
            "interactive_error": "--tui requires an interactive terminal" in all_text,
            "clear_frame_count": all_text.count("\x1b[H"),
            "input_frame_count_after_long": after_long.count("\x1b[H"),
            "input_line_count_after_long": after_long.count("> "),
            "cursor_hide_count": all_text.count("\x1b[?25l"),
            "cursor_restore": "\x1b[?25h" in all_text,
            "exit_status": pty.exitstatus,
            "forced_termination": forced,
            "transcript_chars": len(all_text),
        }
        (case_dir / "pty-transcript.txt").write_text(all_text, encoding="utf-8")
        (case_dir / "pty-metrics.json").write_text(json.dumps(metrics, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        for key, value in metrics.items():
            if key not in {"final_size_reported_by_pty", "transcript_chars"}:
                print(f"{input_mode}.{exit_mode}.{key}={str(value).lower() if isinstance(value, bool) else value}")
        passed = (
            metrics["no_goal_home_only"]
            and not metrics["command_has_goal_flag"]
            and not metrics["command_has_env_file_flag"]
            and metrics["wrapper_isatty"]
            and metrics["chinese_write_ok"]
            and metrics["chinese_visible_after_paste"]
            and metrics["long_write_ok"]
            and metrics["tail_marker_visible_after_long_input"]
            and metrics["input_limit_notice_visible"]
            and not metrics["full_long_input_echoed"]
            and metrics["resize_error_type"] is None
            and metrics["after_resize_separator_width"] == RESIZED_SIZE[1]
            and metrics["after_long_separator_width"] == RESIZED_SIZE[1]
            and not metrics["model_request_visible"]
            and not metrics["interactive_error"]
            and metrics["cursor_hide_count"] >= 1
            and metrics["cursor_restore"]
            and (metrics["escape_write_ok"] and metrics["escape_left_home_edit_mode"] and metrics["quit_write_ok"] if exit_mode == "esc-q" else metrics["ctrl_c_write_ok"])
            and metrics["exit_status"] == 0
            and not metrics["forced_termination"]
        )
        print(f"{input_mode}.{exit_mode}.passed={str(passed).lower()}")
        metrics["passed"] = passed
        (case_dir / "pty-metrics.json").write_text(json.dumps(metrics, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        return metrics
    except Exception as error:
        metrics = {"input_mode": input_mode, "exit_mode": exit_mode, "passed": False, "fatal_type": type(error).__name__}
        (case_dir / "pty-metrics.json").write_text(json.dumps(metrics, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        print(f"{input_mode}.{exit_mode}.fatal_type={type(error).__name__}")
        return metrics
    finally:
        if pty is not None and pty.isalive():
            try:
                pty.close(force=True)
            except Exception:
                pass


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: dev2-tui-ux-pty-probe.py <repo> <node> <ignored-output-dir>")
        return 2
    repo = os.path.abspath(sys.argv[1])
    node = os.path.abspath(sys.argv[2])
    output_root = Path(os.path.abspath(sys.argv[3]))
    output_root.mkdir(parents=True, exist_ok=True)
    cases = (
        ("rapid", "esc-q"),
        ("slow", "esc-q"),
        ("rapid", "ctrl-c"),
        ("slow", "ctrl-c"),
    )
    results = [run_case(repo, node, output_root, input_mode, exit_mode) for input_mode, exit_mode in cases]
    passed = all(result.get("passed") is True for result in results)
    print("overall_passed=" + str(passed).lower())
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

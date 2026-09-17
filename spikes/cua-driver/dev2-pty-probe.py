import json
import os
import select
import sys
import time
from pathlib import Path

from winpty import PtyProcess


def collect(pty, seconds):
    chunks = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        remaining = max(0.0, deadline - time.time())
        ready, _, _ = select.select([pty.fileobj], [], [], min(0.1, remaining))
        if not ready:
            continue
        try:
            value = pty.read(8192)
        except EOFError:
            break
        if value:
            chunks.append(value)
    return "".join(chunks)


def count(text, needle):
    return text.count(needle)


def separator_width(text):
    return max((line.count("\u2500") for line in text.splitlines()), default=0)


def write_bytes(pty, value):
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    return pty.pty.write(value) > 0


def main():
    if len(sys.argv) < 4:
        print("usage_error=true")
        return 2
    repo = os.path.abspath(sys.argv[1])
    node = sys.argv[2]
    local_output = os.path.abspath(sys.argv[3])
    Path(local_output).mkdir(parents=True, exist_ok=True)
    exit_mode = sys.argv[4] if len(sys.argv) >= 5 else "ctrl-c"
    if exit_mode not in {"esc-q", "ctrl-c"}:
        print("usage_error=true")
        return 2

    safe_env = dict(os.environ)
    safe_env["PATH"] = os.path.dirname(node) + os.pathsep + safe_env.get("PATH", "")
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
        "6",
        "--max-model-requests",
        "6",
        "--risk-max-model-requests",
        "1",
        "--output",
        local_output,
    ]
    pty = None
    transcript = []
    forced = False
    resize_error = None
    escape_write = False
    quit_write = False
    ctrl_c_write = False
    try:
        pty = PtyProcess.spawn(argv, cwd=repo, env=safe_env, dimensions=(24, 80))
        initial = collect(pty, 1.5)
        transcript.append(initial)
        paste = "\u53d7\u63a7\u4e2d\u6587\u7c98\u8d34\u6d4b\u8bd5"
        paste_write = write_bytes(pty, paste.encode("utf-8"))
        after_paste = collect(pty, 0.8)
        transcript.append(after_paste)
        try:
            pty.setwinsize(30, 100)
        except Exception as error:
            resize_error = type(error).__name__
        after_resize = collect(pty, 1.0)
        transcript.append(after_resize)
        if exit_mode == "esc-q":
            escape_write = write_bytes(pty, b"\x1b")
            collect(pty, 0.3)
            quit_write = write_bytes(pty, b"q")
        else:
            ctrl_c_write = write_bytes(pty, b"\x03")
        final = collect(pty, 2.0)
        transcript.append(final)

        deadline = time.time() + 2.0
        while pty.isalive() and time.time() < deadline:
            transcript.append(collect(pty, 0.2))
        if pty.isalive():
            try:
                write_bytes(pty, b"\x03")
            except Exception:
                pass
            transcript.append(collect(pty, 1.0))
        if pty.isalive():
            forced = True
            pty.close(force=True)
        exit_status = pty.exitstatus
        all_text = "".join(transcript)
        metrics = {
            "backend": "pywinpty-winpty",
            "exit_mode": exit_mode,
            "wrapper_isatty": bool(pty.isatty()),
            "initial_size": list((24, 80)),
            "final_size_reported_by_adapter": list(pty.getwinsize()),
            "home_marker": "Computer Harness TUI  |  HOME" in all_text,
            "interactive_error": "--tui requires an interactive terminal" in all_text,
            "paste_mask_marker": "(8 characters hidden)" in all_text,
            "raw_paste_visible": paste in all_text,
            "initial_separator_width": separator_width(initial),
            "after_paste_separator_width": separator_width(after_paste),
            "after_resize_separator_width": separator_width(after_resize),
            "resize_error_type": resize_error,
            "clear_frame_count": count(all_text, "\x1b[H\x1b[2J"),
            "cursor_hide_count": count(all_text, "\x1b[?25l"),
            "cursor_restore": "\x1b[?25h" in all_text,
            "paste_write_ok": paste_write,
            "escape_write_ok": escape_write,
            "quit_write_ok": quit_write,
            "ctrl_c_write_ok": ctrl_c_write,
            "exit_status": exit_status,
            "forced_termination": forced,
            "transcript_chars": len(all_text),
        }
        Path(local_output, "pty-transcript.txt").write_text(all_text, encoding="utf-8")
        Path(local_output, "pty-metrics.json").write_text(json.dumps(metrics, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        for key, value in metrics.items():
            if key not in {"final_size_reported_by_adapter", "transcript_chars"}:
                print(key + "=" + str(value).lower() if isinstance(value, bool) else key + "=" + str(value))
        passed = (
            metrics["home_marker"]
            and not metrics["interactive_error"]
            and metrics["paste_mask_marker"]
            and not metrics["raw_paste_visible"]
            and metrics["resize_error_type"] is None
            and metrics["after_resize_separator_width"] == 100
            and metrics["cursor_hide_count"] >= 1
            and metrics["cursor_restore"]
            and metrics["paste_write_ok"]
            and (metrics["ctrl_c_write_ok"] if exit_mode == "ctrl-c" else metrics["escape_write_ok"] and metrics["quit_write_ok"])
            and metrics["exit_status"] == 0
            and not metrics["forced_termination"]
        )
        print("passed=" + str(passed).lower())
        return 0 if passed else 1
    except Exception as error:
        print("fatal_type=" + type(error).__name__)
        return 1
    finally:
        if pty is not None and pty.isalive():
            try:
                pty.close(force=True)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())

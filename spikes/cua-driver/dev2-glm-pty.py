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


def write_text(pty, value):
    return pty.pty.write(value) > 0


def main():
    if len(sys.argv) < 7:
        print("usage_error=true")
        return 2
    repo = os.path.abspath(sys.argv[1])
    node = sys.argv[2]
    socket = sys.argv[3]
    local_output = os.path.abspath(sys.argv[4])
    env_file = sys.argv[5]
    abort_path = os.path.abspath(sys.argv[6])
    Path(local_output).mkdir(parents=True, exist_ok=True)

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

    goal = (
        "Use only the full-screen synthetic Computer Harness DEV2 fixture. "
        "First observe it. Click the button labeled HARNESS PREVIEW once, "
        "click the SAFE SYNTHETIC INPUT FIELD once, type exactly Harness preview, "
        "then finish. Do not use any other window, browser, clipboard, file, or network action."
    )
    argv = [
        node,
        os.path.join("apps", "cli", "dist", "index.js"),
        "--goal",
        goal,
        "--model",
        "glm-5.3-flash",
        "--computer",
        "cua",
        "--cua-socket",
        socket,
        "--output",
        local_output,
        "--env-file",
        env_file,
        "--profile",
        "live-interactive",
        "--risk-guard",
        "layered",
        "--risk-model",
        "off",
        "--max-steps",
        "4",
        "--max-model-requests",
        "6",
        "--risk-max-model-requests",
        "1",
        "--cleanup-deadline-ms",
        "5000",
        "--tui",
    ]

    pty = None
    chunks = []
    forced = False
    q_sent = False
    abort_sent = False
    approval_wait = False
    approval_count = 0
    try:
        pty = PtyProcess.spawn(argv, cwd=repo, env=safe_env, dimensions=(40, 120))
        deadline = time.time() + 240.0
        while time.time() < deadline:
            chunk = collect(pty, 0.25)
            if chunk:
                chunks.append(chunk)
                if approval_wait and ("Approval accepted" in chunk or "Approval rejected" in chunk):
                    approval_wait = False
                if (
                    "APPROVAL:" in chunk
                    and not approval_wait
                    and approval_count < 4
                ):
                    if write_text(pty, "y"):
                        approval_count += 1
                        approval_wait = True
            if os.path.exists(abort_path) and not abort_sent:
                if write_text(pty, "\x03"):
                    abort_sent = True
            if "Run finished:" in chunk and not q_sent:
                time.sleep(0.25)
                q_sent = write_text(pty, "q")
            if not pty.isalive():
                break
        if pty.isalive() and not abort_sent:
            abort_sent = write_text(pty, "\x03")
            chunks.append(collect(pty, 2.0))
        if pty.isalive():
            forced = True
            pty.close(force=True)
        exit_status = pty.exitstatus
        transcript = "".join(chunks)
        metrics = {
            "backend": "pywinpty-winpty",
            "home_marker": "Computer Harness TUI  |  HOME" in transcript,
            "run_marker": "Computer Harness TUI  |  " in transcript and "RUNNING" in transcript,
            "interactive_error": "--tui requires an interactive terminal" in transcript,
            "run_finished_marker": "Run finished:" in transcript,
            "provider_error_marker": "Provider" in transcript and "error" in transcript.lower(),
            "approval_count": approval_count,
            "q_sent": q_sent,
            "abort_sent": abort_sent,
            "cursor_hide_count": transcript.count("\x1b[?25l"),
            "cursor_restore": "\x1b[?25h" in transcript,
            "exit_status": exit_status,
            "forced_termination": forced,
            "transcript_chars": len(transcript),
        }
        Path(local_output, "pty-transcript.txt").write_text(transcript, encoding="utf-8")
        Path(local_output, "pty-metrics.json").write_text(
            json.dumps(metrics, ensure_ascii=True, indent=2) + "\n",
            encoding="utf-8",
        )
        for key, value in metrics.items():
            print(key + "=" + str(value).lower() if isinstance(value, bool) else key + "=" + str(value))
        passed = (
            metrics["run_marker"]
            and not metrics["interactive_error"]
            and metrics["run_finished_marker"]
            and metrics["q_sent"]
            and metrics["cursor_hide_count"] >= 1
            and metrics["cursor_restore"]
            and metrics["exit_status"] == 0
            and not metrics["forced_termination"]
            and metrics["approval_count"] <= 4
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

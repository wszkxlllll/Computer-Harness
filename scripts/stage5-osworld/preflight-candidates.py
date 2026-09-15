"""Static preflight for the frozen OSWorld candidate document.

This intentionally does not start VMware, reset a task, or invoke a model. It
only validates task JSON shape and that the official metric/getter names are
available in the checked-out OSWorld source.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


TASK_ID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)


def getter_types(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    return [item["type"] for item in values if isinstance(item, dict) and isinstance(item.get("type"), str)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osworld-root", type=Path, required=True)
    parser.add_argument("--candidate-doc", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    osworld_root = args.osworld_root.resolve()
    sys.path.insert(0, str(osworld_root))
    from desktop_env.evaluators import getters, metrics  # type: ignore

    task_root = osworld_root / "evaluation_examples" / "examples"
    candidate_text = args.candidate_doc.read_text(encoding="utf-8")
    # JSON manifests may contain provenance IDs such as replacementOf. Only
    # taskId entries are candidates; do not mistake audit metadata for tasks.
    try:
        candidate_manifest = json.loads(candidate_text)
    except json.JSONDecodeError:
        candidate_manifest = None
    if isinstance(candidate_manifest, dict) and isinstance(candidate_manifest.get("tasks"), list):
        task_ids = list(dict.fromkeys(
            task["taskId"]
            for task in candidate_manifest["tasks"]
            if isinstance(task, dict) and isinstance(task.get("taskId"), str)
        ))
    else:
        task_ids = list(dict.fromkeys(TASK_ID_RE.findall(candidate_text)))
    task_files = {path.stem: path for path in task_root.rglob("*.json")}
    rows: list[dict[str, Any]] = []

    for task_id in task_ids:
        path = task_files.get(task_id)
        reasons: list[str] = []
        task: dict[str, Any] | None = None
        if path is None:
            reasons.append("missing_task_json")
        else:
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(loaded, dict):
                    reasons.append("task_json_not_object")
                else:
                    task = loaded
            except Exception as exc:  # pragma: no cover - diagnostic path
                reasons.append(f"task_json_parse_error:{type(exc).__name__}")

        evaluator = task.get("evaluator") if task is not None else None
        if not isinstance(evaluator, dict):
            reasons.append("missing_evaluator")
            evaluator = {}

        function_value = evaluator.get("func")
        functions = function_value if isinstance(function_value, list) else [function_value]
        function_names = [value for value in functions if isinstance(value, str)]
        if not function_names:
            reasons.append("missing_evaluator_function")
        if function_value == "infeasible":
            reasons.append("infeasible_evaluator")
        missing_metrics = [name for name in function_names if not hasattr(metrics, name)]
        if missing_metrics:
            reasons.append("missing_metric:" + ",".join(missing_metrics))

        getter_names = getter_types(evaluator.get("result")) + getter_types(evaluator.get("expected"))
        missing_getters = [name for name in getter_names if not hasattr(getters, "get_" + name)]
        if missing_getters:
            reasons.append("missing_getter:" + ",".join(missing_getters))

        if task is not None:
            if task.get("proxy") is not False:
                reasons.append("proxy_not_false")
            if task.get("possibility_of_env_change") != "low":
                reasons.append("env_change_not_low")
            if not isinstance(task.get("snapshot"), str) or not task["snapshot"].strip():
                reasons.append("missing_snapshot_field")
            if not isinstance(task.get("config"), list) or not task["config"]:
                reasons.append("missing_config")

        rows.append(
            {
                "taskId": task_id,
                "path": None if path is None else str(path.relative_to(task_root)),
                "status": "pass" if not reasons else "reject",
                "reasons": reasons,
                "snapshot": None if task is None else task.get("snapshot"),
                "evaluatorFunctions": function_value,
                "configCount": None if task is None or not isinstance(task.get("config"), list) else len(task["config"]),
            }
        )

    result = {
        "kind": "osworld-candidate-static-preflight",
        "osworldRoot": str(osworld_root),
        "taskRoot": str(task_root),
        "candidateDocument": str(args.candidate_doc.resolve()),
        "taskCount": len(rows),
        "passed": sum(row["status"] == "pass" for row in rows),
        "rejected": sum(row["status"] == "reject" for row in rows),
        "snapshots": dict(Counter(row["snapshot"] for row in rows if row["snapshot"])),
        "rows": rows,
        "dynamicChecks": {
            "bridgeReset": "not_run",
            "initialScreenshot": "not_run",
            "applicationLaunch": "not_run",
            "cleanup": "not_run",
            "reason": "static preflight does not start VMware or mutate a task environment",
        },
    }
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if result["rejected"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Prepare a concrete D01 Goal. Does not launch Harness or write task outputs."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path, PureWindowsPath
import re
from zoneinfo import ZoneInfo


def date_value(value):
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("日期必须为YYYY-MM-DD") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--family", required=True, help="cardId或完整familyId")
    parser.add_argument("--variant", choices=["v1", "v2"], required=True)
    parser.add_argument("--target-date", type=date_value)
    parser.add_argument("--preferred-date", type=date_value)
    parser.add_argument("--run-date", type=date_value,
                        default=dt.datetime.now(ZoneInfo("Asia/Shanghai")).date())
    parser.add_argument("--output-file", help="本Run唯一、尚不存在的Windows绝对.txt路径")
    args = parser.parse_args()
    raw = args.manifest.read_bytes()
    manifest = json.loads(raw)
    if manifest.get("status") != "task_contract_frozen":
        parser.error("只准备本轮已冻结任务合同，未冻结候选不能启动")
    families = [f for f in manifest["taskFamilies"]
                if args.family in (f["id"], f["cardId"])]
    if len(families) != 1:
        parser.error("family必须唯一存在")
    family = families[0]
    variants = [v for v in family["variants"] if v["id"] == args.variant]
    if len(variants) != 1:
        parser.error("variant必须唯一存在")
    variant = variants[0]
    goal = variant["goal"]
    bindings = {}
    if "targetWeekday" in variant:
        if args.target_date is None:
            parser.error("M02须提供已人工核对可见表头的--target-date")
        if args.target_date.isoweekday() != variant["targetWeekday"]:
            parser.error("目标日期与冻结星期条件不一致")
        bindings["targetDate"] = args.target_date.isoformat()
    if variant.get("needsPreferredDate"):
        preferred = args.preferred_date
        if preferred is None:
            preferred = args.run_date + dt.timedelta(days=1)
            while preferred.isoweekday() > 5:
                preferred += dt.timedelta(days=1)
        if not (1 <= (preferred - args.run_date).days <= 3) or preferred.isoweekday() > 5:
            parser.error("期望咨询日期须为运行日后3天内的工作日；不是服务预约")
        bindings["preferredDate"] = preferred.isoformat()
    if variant.get("needsOutputFile"):
        if not args.output_file:
            parser.error("文件任务必须指定--output-file")
        target = PureWindowsPath(args.output_file)
        if not target.is_absolute() or target.suffix.lower() != ".txt":
            parser.error("输出须为Windows绝对.txt路径，不能是相对路径")
        bindings["outputFile"] = str(target)
    for key, value in bindings.items():
        goal = goal.replace("{{" + key + "}}", value)
    if re.search(r"\{\{[^}]+\}\}", goal):
        parser.error("Goal仍有未展开变量")
    prepared = {
        "schemaVersion": 1,
        "manifestId": manifest["manifestId"],
        "manifestSha256": hashlib.sha256(raw).hexdigest(),
        "familyId": family["id"], "cardId": family["cardId"],
        "variantId": variant["id"], "split": variant["split"],
        "runDate": args.run_date.isoformat(), "bindings": bindings,
        "goal": goal,
        "goalSha256": hashlib.sha256(goal.encode("utf-8")).hexdigest(),
        "requiredConfiguration": manifest["runtimeConfiguration"],
        "executionRelease": manifest["executionRelease"],
        "preparationOnly": True,
        "remainingOperatorChecks": [
            "Windows源码/锁文件/驱动/模型/Guard/实际窗口许可与冻结配置一致",
            "当前官方页面内容和初态真值通过；M02具体日期属于可见范围且列对应正确",
            "输出路径在本Run新目录中且不存在；此工具不访问Windows文件系统证明存在性",
            "操作者保存Run初态证据与实例hash，独立人审已安排"
        ]
    }
    print(json.dumps(prepared, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

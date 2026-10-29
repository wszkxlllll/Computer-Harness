#!/usr/bin/env node
/**
 * batch-evaluate.mjs
 * 批量轨迹评估框架 — 遍历 runs 目录下所有 trajectory.jsonl，
 * 逐份调用 evaluate-trajectory.mjs（D01 五维评分），汇总为 CSV + JSON 报告。
 *
 * Usage:
 *   node scripts/validation/stage4-local/batch-evaluate.mjs \
 *     [--runs-root <dir>]           # 默认 runs/（相对仓库根）
 *     [--manifests <dir-or-file>]   # 默认 eval/candidates（递归找 *.json）
 *     [--family <id>] [--variant <id>]  # 显式指定；缺省则从 manifest 取每个 family×variant 组合
 *     [--output-dir <dir>]          # 默认 工作区根 batch-eval-<时间戳>/（产物出仓库，遵循测试产物位置纪律）
 *     [--smoke]                     # 冒烟模式：只验证脚本管线，结果标注"口径不匹配、仅演练"
 *
 * 输出：
 *   <output-dir>/batch-results.json   全量明细（每份轨迹 × 每个 family/variant 组合的完整评估结果）
 *   <output-dir>/batch-summary.csv    汇总表（一行一次评估）
 *   <output-dir>/batch-report.md      人读报告（按 manifest 分组的 verdict 分布 + 复核项统计）
 *
 * 设计约束：
 *   - 不修改评估器本体；子进程调用，隔离崩溃
 *   - manifest 与轨迹无绑定关系时（goal 口径不匹配）结果标注 status="exercise_only"
 *   - evaluation_error 不改写成功/失败（遵循 scenario-evaluation-and-three-person-plan §6）
 */

import { readFile, readdir, writeFile, mkdir, stat } from "fs/promises";
import { dirname, join, relative, resolve, basename } from "path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EVALUATOR_PATH = resolve(REPO_ROOT, "scripts/validation/stage4-local/evaluate-trajectory.mjs");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { "runs-root": "runs", manifests: "eval/candidates", smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    switch (key) {
      case "--smoke":
        args.smoke = true;
        break;
      case "--runs-root":
      case "--manifests":
      case "--family":
      case "--variant":
      case "--output-dir":
        args[key.slice(2)] = argv[++i];
        break;
      default:
        console.error(`unknown option: ${key}`);
        process.exit(1);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
async function findTrajectories(root) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "assets" || entry.name === "screenshots") continue;
        await walk(full);
      } else if (entry.name === "trajectory.jsonl") {
        results.push(full);
      }
    }
  }
  await walk(resolve(root));
  return results.sort();
}

async function findManifests(root) {
  if ((await stat(resolve(root))).isFile()) return [resolve(root)];
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".result.json")) {
        results.push(full);
      }
    }
  }
  await walk(resolve(root));
  return results.sort();
}

// ---------------------------------------------------------------------------
// Manifest inspection
// ---------------------------------------------------------------------------
/** 列出 manifest 里所有 family×variant 评估组合 */
function listEvaluationCombinations(manifest) {
  const combos = [];
  if (!Array.isArray(manifest.taskFamilies)) return combos;
  for (const family of manifest.taskFamilies) {
    if (!family?.id) continue;
    const variants = Array.isArray(family.variants) ? family.variants : [];
    if (variants.length === 0) {
      combos.push({ familyId: family.id, variantId: null });
    } else {
      for (const variant of variants) {
        if (!variant?.id) continue;
        combos.push({ familyId: family.id, variantId: variant.id });
      }
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Trajectory inspection（轻量：只读 run.finished 与 goal，判定口径是否可能匹配）
// ---------------------------------------------------------------------------
async function inspectTrajectory(path) {
  const events = [];
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 单行损坏不致命，继续
    }
  }
  const created = events.find((e) => e.type === "run.created");
  const finished = events.find((e) => e.type === "run.finished");
  return {
    events,
    goal: created?.goal ?? null,
    runId: created?.runId ?? null,
    outcome: finished?.outcome ?? null,
    eventCount: events.length,
  };
}

/** 粗查 goal 是否包含 family 的特征词（决定是否标记 exercise_only） */
function goalMightMatchFamily(goal, family) {
  if (!goal || !family) return false;
  const goalLower = goal.toLowerCase();
  const familyIdLower = family.id.toLowerCase();
  // 特征词优先取 goalTemplate 里的关键词，退化用 familyId 的分词
  const tokens = familyIdLower.split("_").filter((t) => t.length > 3);
  return tokens.some((t) => goalLower.includes(t));
}

// ---------------------------------------------------------------------------
// Evaluator subprocess
// ---------------------------------------------------------------------------
function runEvaluatorOnce(trajectoryPath, manifestPath, familyId, variantId, outputPath) {
  return new Promise((resolvePromise) => {
    const args = [
      EVALUATOR_PATH,
      "--trajectory", trajectoryPath,
      "--manifest", manifestPath,
      "--family", familyId,
      "--output", outputPath,
    ];
    if (variantId != null) args.push("--variant", variantId);
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ ok: false, error: "evaluator timeout (60s)" });
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ ok: true });
      } else {
        resolvePromise({ ok: false, error: `exit ${code}: ${stderr.slice(-400)}` });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: `spawn failed: ${err.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  const runsRoot = resolve(args["runs-root"]);
  const manifestsRoot = resolve(args.manifests);
  const outputDir = args["output-dir"]
    ? resolve(args["output-dir"])
    : resolve(REPO_ROOT, "..", `batch-eval-${startedAt.toISOString().slice(0, 19).replace(/[:T]/g, "")}`);
  await mkdir(outputDir, { recursive: true });

  console.error(`batch-evaluate: runs=${args["runs-root"]} manifests=${args.manifests} out=${relative(process.cwd(), outputDir)}`);
  if (args.smoke) console.error("（冒烟模式：结果仅演练口径，不代表业务评估）");

  // 1. 发现文件
  const trajectoryPaths = await findTrajectories(runsRoot);
  const manifestPaths = await findManifests(manifestsRoot);
  console.error(`发现 ${trajectoryPaths.length} 份轨迹、${manifestPaths.length} 份 manifest 候选`);

  // 2. 载入 manifest（过滤出具备 taskFamilies 结构的 D01 manifest）
  const manifests = [];
  for (const path of manifestPaths) {
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (Array.isArray(manifest?.taskFamilies) && manifest.taskFamilies.length > 0) {
        manifests.push({ path, manifest });
        continue;
      }
    } catch {
      // 非 JSON 或结构不符，跳过
    }
  }
  if (manifests.length === 0) {
    console.error("未找到任何包含 taskFamilies 的 manifest，退出。");
    process.exit(1);
  }
  for (const m of manifests) {
    console.error(`  manifest: ${relative(REPO_ROOT, m.path)} (${m.manifest.manifestId ?? "?"})`);
  }

  // 3. 逐轨迹 × 逐 manifest（× 显式或全部 family/variant 组合）评估
  const results = [];
  let evaluationErrors = 0;

  for (const trajPath of trajectoryPaths) {
    const trajRel = relative(REPO_ROOT, trajPath);
    let inspection;
    try {
      inspection = await inspectTrajectory(trajPath);
    } catch (err) {
      results.push({ trajectory: trajRel, status: "evaluation_error", error: `读取失败: ${err.message}` });
      evaluationErrors++;
      continue;
    }

    for (const { path: manifestPath, manifest } of manifests) {
      const manifestRel = relative(REPO_ROOT, manifestPath);
      const manifestId = manifest.manifestId ?? basename(manifestPath);

      // 决定评估组合：显式指定优先，否则全组合
      let combinations;
      if (args.family) {
        // 显式 --family 时跳过不含该 family 的 manifest（而非记 evaluation_error）
        if (!manifest.taskFamilies.some((f) => f.id === args.family)) continue;
        combinations = [{ familyId: args.family, variantId: args.variant ?? null }];
      } else {
        combinations = listEvaluationCombinations(manifest);
      }

      for (const { familyId, variantId } of combinations) {
        const family = manifest.taskFamilies.find((f) => f.id === familyId);
        if (!family) {
          results.push({
            trajectory: trajRel, manifestId, familyId, variantId,
            status: "evaluation_error", error: `manifest 中不存在 family "${familyId}"`,
          });
          evaluationErrors++;
          continue;
        }

        const comboLabel = variantId ? `${familyId}/${variantId}` : familyId;
        // 口径粗查：goal 与 family 完全无关时标 exercise_only（结果仍产出，但不计入业务汇总）
        const possibleMatch = goalMightMatchFamily(inspection.goal, family);
        const status = args.smoke || !possibleMatch ? "exercise_only" : "assessed";

        const outputPath = join(
          outputDir,
          "detail",
          trajRel.replaceAll(/[^\w.-]+/g, "__"),
          `${manifestId}__${familyId}${variantId ? `__${variantId}` : ""}.json`
        );
        await mkdir(dirname(outputPath), { recursive: true });

        const run = await runEvaluatorOnce(trajPath, manifestPath, familyId, variantId, outputPath);
        if (!run.ok) {
          results.push({
            trajectory: trajRel, manifestId, familyId, variantId, status: "evaluation_error",
            error: run.error, runId: inspection.runId, goal: inspection.goal,
          });
          evaluationErrors++;
          continue;
        }

        let detail;
        try {
          detail = JSON.parse(await readFile(outputPath, "utf8"));
        } catch (err) {
          results.push({
            trajectory: trajRel, manifestId, familyId, variantId, status: "evaluation_error",
            error: `评估器输出解析失败: ${err.message}`,
          });
          evaluationErrors++;
          continue;
        }

        results.push({
          trajectory: trajRel,
          runId: inspection.runId,
          goal: inspection.goal?.slice(0, 120) ?? null,
          runtimeOutcome: inspection.outcome,
          eventCount: inspection.eventCount,
          manifestId,
          manifestRel,
          familyId,
          variantId,
          status,
          verdict: detail.verdict,
          success: detail.success,
          scores: detail.scores,
          manualReviewCount: detail.humanReview?.pendingChecks?.length ?? 0,
          evidenceDeficiencyCount: detail.deficiencies?.length ?? 0,
          humanReviewStatus: detail.humanReview?.status ?? "pending",
          reason: detail.reason,
          detailPath: relative(outputDir, outputPath),
        });
        console.error(`  ${status === "assessed" ? "▶" : "·"} ${trajRel} × ${comboLabel} → ${detail.verdict}${status === "exercise_only" ? "（演练）" : ""}`);
      }
    }
  }

  // 4. 汇总输出
  const assessed = results.filter((r) => r.status === "assessed");
  const exercised = results.filter((r) => r.status === "exercise_only");
  const byVerdict = (list) => {
    const counts = { success: 0, partial: 0, nearMiss: 0, inconclusive: 0 };
    for (const r of list) if (counts[r.verdict] !== undefined) counts[r.verdict]++;
    return counts;
  };

  const summary = {
    schemaVersion: 1,
    tool: "batch-evaluate-v2",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    smokeMode: args.smoke,
    runsRoot: relative(REPO_ROOT, runsRoot),
    manifestsRoot: relative(REPO_ROOT, manifestsRoot),
    totals: {
      trajectories: trajectoryPaths.length,
      manifests: manifests.length,
      evaluations: results.length,
      assessed: assessed.length,
      exerciseOnly: exercised.length,
      evaluationErrors,
    },
    verdictDistribution: {
      assessed: byVerdict(assessed),
      exerciseOnly: byVerdict(exercised),
    },
    caveat: assessed.length === 0
      ? "本轮无 assessed 结果：现有轨迹 goal 与 manifest 任务族口径不匹配（基础设施验证轨迹 ≠ D01 业务任务）。结果仅证明评估管线可用。"
      : null,
    results,
  };

  await writeFile(join(outputDir, "batch-results.json"), JSON.stringify(summary, null, 2), "utf8");

  // CSV
  const csvHeader = "trajectory,manifestId,familyId,variantId,status,verdict,success,completion,infoAccuracy,errorPrevention,crossAppCorrectness,safetyCompliance,manualReviewCount,runtimeOutcome";
  const csvLines = results.map((r) =>
    [
      r.trajectory, r.manifestId ?? "", r.familyId ?? "", r.variantId ?? "",
      r.status, r.verdict ?? "", r.success ?? "",
      ...["completion", "infoAccuracy", "errorPrevention", "crossAppCorrectness", "safetyCompliance"]
        .map((name) => typeof r.scores?.[name] === "number" ? r.scores[name].toFixed(2) : ""),
      r.manualReviewCount ?? "", r.runtimeOutcome ?? "",
    ].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")
  );
  await writeFile(join(outputDir, "batch-summary.csv"), [csvHeader, ...csvLines].join("\n"), "utf8");

  // Markdown 报告
  const reportLines = [
    "# 批量评估报告",
    "",
    `- 生成时间：${summary.finishedAt}`,
    `- 模式：${args.smoke ? "冒烟演练" : "标准"}`,
    `- 轨迹：${summary.totals.trajectories} 份；manifest：${summary.totals.manifests} 份；评估组合：${summary.totals.evaluations} 次`,
    `- 分布：assessed=${summary.totals.assessed}、exercise_only=${summary.totals.exerciseOnly}、evaluation_error=${summary.totals.evaluationErrors}`,
    "",
    "## 判定分布",
    "",
    `| 状态 | success | partial | nearMiss | inconclusive |`,
    `|---|---|---|---|---|`,
    `| assessed | ${summary.verdictDistribution.assessed.success} | ${summary.verdictDistribution.assessed.partial} | ${summary.verdictDistribution.assessed.nearMiss} | ${summary.verdictDistribution.assessed.inconclusive} |`,
    `| exercise_only（演练） | ${summary.verdictDistribution.exerciseOnly.success} | ${summary.verdictDistribution.exerciseOnly.partial} | ${summary.verdictDistribution.exerciseOnly.nearMiss} | ${summary.verdictDistribution.exerciseOnly.inconclusive} |`,
    "",
  ];
  if (summary.caveat) {
    reportLines.push(`> ⚠️ ${summary.caveat}`, "");
  }
  if (assessed.length > 0) {
    reportLines.push("## assessed 明细", "", "| 轨迹 | family/variant | verdict | 安全分 | 复核项数 |", "|---|---|---|---|---|");
    for (const r of assessed) {
      reportLines.push(`| ${r.trajectory} | ${r.familyId}${r.variantId ? "/" + r.variantId : ""} | ${r.verdict} | ${r.scores?.safetyCompliance ?? "未知"} | ${r.manualReviewCount} |`);
    }
    reportLines.push("");
  }
  reportLines.push("## 演练明细（口径不匹配，不代表业务结果）", "", "| 轨迹 | manifest | family/variant | verdict |", "|---|---|---|---|");
  for (const r of exercised.slice(0, 30)) {
    reportLines.push(`| ${r.trajectory} | ${r.manifestId} | ${r.familyId}${r.variantId ? "/" + r.variantId : ""} | ${r.verdict ?? "?"} |`);
  }
  if (exercised.length > 30) reportLines.push(`| …（其余 ${exercised.length - 30} 条见 batch-results.json） | | | |`);
  reportLines.push("");

  const errorRows = results.filter((r) => r.status === "evaluation_error");
  if (errorRows.length > 0) {
    reportLines.push("## 评估错误（evaluation_error 不改写成败，需人工核查）", "");
    for (const r of errorRows) {
      reportLines.push(`- ${r.trajectory} × ${r.familyId ?? "?"}: ${r.error}`);
    }
    reportLines.push("");
  }

  await writeFile(join(outputDir, "batch-report.md"), reportLines.join("\n"), "utf8");

  console.error(`\n完成：${summary.totals.evaluations} 次评估 → ${outputDir}`);
  console.error(`  assessed=${summary.totals.assessed} exercise_only=${summary.totals.exerciseOnly} errors=${summary.totals.evaluationErrors}`);
  if (summary.totals.evaluationErrors > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error("batch-evaluate error:", err);
  process.exit(1);
});

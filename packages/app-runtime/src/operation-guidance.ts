import { createHash } from "node:crypto";
import type { ContextCompileInput, ContextOperationGuidance } from "@computer-harness/runtime";

type OperationGuidanceId = "text_document_save" | "structured_extract";

const catalog = {
  text_document_save: makeEntry(
    "text_document_save",
    "编辑前核对空白/已有内容；长输入只看到尾部，不代表前缀丢失。正文保留原文空白与末尾LF，不自行增删。菜单明确显示快捷键时优先使用；文件名框裁剪不等于路径丢失。Cmd-Shift-G定位；列视图祖先≠当前位置。TextEdit：Make Plain Text转纯文本；首次Save；Option核对Save As；Shift-Cmd-S可能Duplicate。分清前往文件夹、文件名和已保存标题：完整输入指定文件名及后缀，勿假定补全；核目录/全名再保存；过渡不明时独立wait(0)一次，仍不明则报告未确认，不重复Enter。内容正确≠精确路径；Cmd+S未必重开面板，标题不单独证明保存。macOS关闭用[\"CMD\",\"W\"]；[\"W\"]只输入字符。",
  ),
  structured_extract: makeEntry(
    "structured_extract",
    "整理查询或比较结果时，只记录界面或来源明确给出的关系。价格与类别没有明确关联时分开列出或标为未知，不推断配对；不要把推断保存成 Memory 事实。",
  ),
} satisfies Record<OperationGuidanceId, ContextOperationGuidance>;

const documentAppLabels = new Set([
  "libreoffice writer", "microsoft word", "notepad", "textedit", "word", "wordpad", "writer", "text editor", "记事本", "写字板",
]);
const structuredResearchAppLabels = new Set([
  "browser", "chrome", "edge", "firefox", "google chrome", "microsoft edge", "msedge", "浏览器",
]);

/** Pure matcher over user task intent and existing Run metadata; it makes no model or filesystem calls. */
export function selectOperationGuidance(
  input: Pick<ContextCompileInput, "goal" | "recentEvents" | "plan" | "windowSwitchState">,
): ContextOperationGuidance | undefined {
  const latestCorrection = [...input.recentEvents].reverse().find((event) => event.type === "user.input.received");
  const correctionText = latestCorrection?.type === "user.input.received" ? latestCorrection.text : undefined;
  const correctionCategories = correctionText === undefined ? [] : categoriesForText(correctionText);
  const correctionChangesScope = correctionText !== undefined && expressesIntentChange(correctionText);
  const taskCategories = correctionText !== undefined && (correctionCategories.length > 0 || correctionChangesScope)
    ? correctionCategories
    : categoriesForText(input.goal);
  if (taskCategories.length === 0) return undefined;

  // Labels are environmental text. Exact aliases can break a tie, but never
  // gate the Goal match or become instruction text; window titles are ignored.
  const appHint = categoryForAppLabel(input.windowSwitchState?.currentWindow?.appName);
  const activePhases = input.plan?.tasks.filter((task) => task.status === "in_progress") ?? [];
  const phaseCategories = activePhases.length === 1
    ? categoriesForText(`${activePhases[0]!.subject} ${activePhases[0]!.description ?? ""}`)
    : [];
  const phaseHint = phaseCategories.length === 1 ? phaseCategories[0] : undefined;
  const appCandidate = appHint !== undefined && taskCategories.includes(appHint) ? appHint : undefined;
  const phaseCandidate = phaseHint !== undefined && taskCategories.includes(phaseHint) ? phaseHint : undefined;
  if (appCandidate !== undefined && phaseCandidate !== undefined && appCandidate !== phaseCandidate) {
    return combinedTaskGuidance();
  }
  const selected = appCandidate ?? phaseCandidate;
  if (selected !== undefined) return catalog[selected];
  return taskCategories.length === 1 ? catalog[taskCategories[0]!] : combinedTaskGuidance();
}

function categoriesForText(value: string): OperationGuidanceId[] {
  const text = normalize(value);
  const categories: OperationGuidanceId[] = [];
  if (matchesDocumentSaveTask(text) && !negatesDocumentSaveTask(text)) categories.push("text_document_save");
  if (matchesStructuredExtractTask(text) && !negatesStructuredExtractTask(text)) categories.push("structured_extract");
  return categories;
}

function matchesDocumentSaveTask(text: string): boolean {
  return /(?:新(?:建|增)?.{0,8}|创建|撰写|写(?:入|一份|一个|个)?|编辑|制作).{0,20}(?:文档|文件|报告|说明|笔记)|(?:文档|文件|报告|说明|笔记).{0,24}(?:保存|另存|写入)|\b(?:new|create|draft|write|edit|save(?:\s+as)?)\b.{0,48}\b(?:document|file|report|note)\b|\b(?:document|file|report|note)\b.{0,40}\b(?:save(?:\s+as)?|write)\b/iu.test(text);
}

function negatesDocumentSaveTask(text: string): boolean {
  return /(?:不要|不需要|不用|取消|停止|不再|先不|暂不|别)\s*(?:再|继续)?\s*(?:新(?:建|增)?|创建|撰写|写入|写|编辑|制作|保存|另存)|\b(?:don't|do not|stop|cancel|avoid|no longer)\s+(?:new|create|draft|write|edit|save)\b/iu.test(text);
}

function matchesStructuredExtractTask(text: string): boolean {
  return /比较|对比|对照|\bcompare(?:d|s)?\b|\bcomparison\b|(?:查询|搜索|检索|查找).{0,12}(?:结果|信息|列表|候选)|(?:结果|信息|列表|候选).{0,12}(?:查询|搜索|检索|查找)|\b(?:search|query|lookup)\s+results?\b/iu.test(text);
}

function negatesStructuredExtractTask(text: string): boolean {
  return /(?:不要|不需要|不用|取消|停止|不再|先不|暂不|别)\s*(?:再|继续)?\s*(?:比较|对比|对照|查询|搜索|检索|查找|汇总|整理)|\b(?:don't|do not|stop|cancel|avoid|no longer)\s+(?:compare|search|query|lookup)\b/iu.test(text);
}

function expressesIntentChange(text: string): boolean {
  return /(?:改为|改成|换成|取消|停止|不再|先不|暂不|不要继续|instead|switch to|change to|cancel|stop|no longer|forget (?:about|the))/iu.test(text) ||
    /(?:不要|别)\s*(?:再|继续)?\s*(?:新(?:建|增)?|创建|撰写|写入|写|编辑|制作|保存|另存|比较|对比|对照|查询|搜索|检索|查找)/iu.test(text) ||
    /\b(?:don't|do not)\s+(?:new|create|draft|write|edit|save|compare|search|query|lookup)\b/iu.test(text);
}

function categoryForAppLabel(value: string | undefined): OperationGuidanceId | undefined {
  if (value === undefined) return undefined;
  const label = normalize(value).replace(/\.exe$/u, "");
  if (documentAppLabels.has(label)) return "text_document_save";
  if (structuredResearchAppLabels.has(label)) return "structured_extract";
  return undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function makeEntry(id: string, text: string): ContextOperationGuidance {
  return {
    id,
    fingerprint: createHash("sha256").update(`${id}\n${text}`, "utf8").digest("hex"),
    text,
  };
}

function combinedTaskGuidance(): ContextOperationGuidance {
  return makeEntry(
    "combined_task_guidance",
    `${catalog.text_document_save.text}\n${catalog.structured_extract.text}`,
  );
}

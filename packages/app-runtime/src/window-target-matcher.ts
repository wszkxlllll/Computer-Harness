import type { WindowTargetInfo } from "./application-session.js";

interface ScoredWindowTarget {
  readonly target: WindowTargetInfo;
  readonly score: number;
}

export type WindowGoalMatch =
  | { readonly kind: "matched"; readonly match: { readonly target: WindowTargetInfo } }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "none" };

const MIN_CONFIDENT_SCORE = 4;

/** Strong placement syntax makes an application a target constraint; an open-title phrase alone does not. */
export function hasExplicitApplicationIntent(goal: string): boolean {
  return explicitApplicationHint(goal.normalize("NFKC").toLocaleLowerCase()) !== undefined;
}

/** Constrain a semantic selector to the explicitly named application when it has a lexical app-name match. */
export function targetsForExplicitApplicationIntent(
  goal: string,
  targets: readonly WindowTargetInfo[],
): readonly WindowTargetInfo[] {
  const hint = explicitApplicationHint(goal.normalize("NFKC").toLocaleLowerCase());
  return hint === undefined ? targets : targets.filter((target) => appNameHasExactTerm(target.appName ?? "", hint));
}

/**
 * Initial target matching chooses an independently usable application root,
 * not a second app candidate for a child already owned by that root. The
 * producer only emits `owned_child` after one complete trusted inventory
 * proves the exact owner pair and its root owner (0/0). Keep the original
 * inventory intact for Run startup and later Surface handling.
 */
export function filterInitialTargetWindowCandidates(targets: readonly WindowTargetInfo[]): readonly WindowTargetInfo[] {
  const byIdentity = new Map<string, WindowTargetInfo>();
  const duplicateIdentities = new Set<string>();
  for (const target of targets) {
    const key = windowIdentityKey(target.pid, target.windowId);
    if (byIdentity.has(key)) duplicateIdentities.add(key);
    else byIdentity.set(key, target);
  }

  const provenChildren = new Set<WindowTargetInfo>();
  for (const child of targets) {
    const relationship = child.relationship;
    if (relationship?.kind !== "owned_child") continue;
    if (!isPositiveSafeInteger(child.pid) || !isPositiveSafeInteger(child.windowId) ||
      !isPositiveSafeInteger(relationship.owner.pid) || !isPositiveSafeInteger(relationship.owner.windowId)) continue;
    const childKey = windowIdentityKey(child.pid, child.windowId);
    const ownerKey = windowIdentityKey(relationship.owner.pid, relationship.owner.windowId);
    if (childKey === ownerKey || duplicateIdentities.has(childKey) || duplicateIdentities.has(ownerKey)) continue;
    const owner = byIdentity.get(ownerKey);
    // The discovery producer emits this typed relationship only after an
    // exact owner row was proven root-owned in the same complete snapshot.
    // Exclude the child only while that independent root remains an eligible
    // candidate. If visibility projection hid the owner, keep the visible
    // child available rather than emptying the initial target pool.
    if (owner !== undefined && owner.relationship?.kind !== "owned_child") provenChildren.add(child);
  }
  return targets.filter((target) => !provenChildren.has(target));
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function windowIdentityKey(pid: number, windowId: number): string {
  return `${pid}:${windowId}`;
}

/** Withhold identical display identities; PID/HWND are not semantic evidence for a blind model choice. */
export function filterIndistinguishableWindowTargets(
  targets: readonly WindowTargetInfo[],
  allowTrustedRelationshipDistinction = false,
): readonly WindowTargetInfo[] {
  const counts = new Map<string, number>();
  const keys = targets.map((target) => windowDisplayIdentityKey(
    target.appName,
    target.title,
    allowTrustedRelationshipDistinction ? target.relationship : undefined,
  ));
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return targets.filter((_, index) => counts.get(keys[index]!) === 1);
}

function windowDisplayIdentityKey(
  appName: string | undefined,
  title: string | undefined,
  relationship?: WindowTargetInfo["relationship"],
): string {
  const normalize = (value: string | undefined) => value?.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() ?? "";
  const relationshipLabel = relationship?.kind === "owned_child"
    ? `owned:${relationship.rootRole ?? "unclassified"}`
    : relationship?.kind === "scoped_peer" ? "scoped-peer" : "unproven";
  return `${normalize(appName)}\u0000${normalize(title)}\u0000${relationshipLabel}`;
}

const GENERIC_LATIN_TERMS = new Set([
  "account", "application", "browser", "code", "current", "default", "desktop", "document", "file",
  "home", "inbox", "list", "mail", "manager", "message", "new", "order", "orders", "page",
  "profile", "result", "results", "screen", "search", "settings", "site", "spreadsheet", "tab", "task",
  "untitled", "unknown", "website", "window", "word", "workbook",
]);
const GOAL_ACTION_TERMS = new Set([
  "a", "an", "and", "at", "check", "click", "find", "for", "from", "go", "inspect", "in", "run",
  "launch", "look", "my", "navigate", "of", "on", "open", "please", "review", "search", "start",
  "the", "then", "this", "to", "use", "visit", "with",
]);

const HAN_TITLE_PREFIXES = ["切换到", "访问", "打开", "查看", "检查", "使用", "搜索", "查询", "当前", "我的"];
const HAN_TITLE_SUFFIXES = ["新标签页", "标签页", "浏览器", "搜索结果", "查询结果", "网页", "页面", "网站", "窗口", "桌面", "应用", "程序", "主页", "首页", "列表", "结果"];
const GENERIC_HAN_APP_NAMES = new Set(["浏览器", "应用", "程序", "窗口", "桌面"]);
const HAN_IDENTITY_ACTION_PREFIXES = ["切换到", "访问", "打开", "查看", "检查", "使用", "运行", "在"];
const HAN_IDENTITY_CONNECTORS = ["并", "然后", "中", "里", "里面", "上"];

/**
 * Rank visible windows using complete app-name or title identities. Shared
 * words such as "Google" or a partial name such as "Chrome" inside "Chrome
 * extension" are insufficient. A result is auto-selectable only when exactly
 * one target has confident identity evidence. Window metadata remains local.
 */
export function matchGoalToWindow(goal: string, targets: readonly WindowTargetInfo[]): WindowGoalMatch {
  const normalizedGoal = goal.normalize("NFKC").toLocaleLowerCase();
  const explicitHint = explicitApplicationHint(normalizedGoal);
  const titleMatchGoal = leadingChineseAppTargetRemainder(normalizedGoal) ?? normalizedGoal;
  const goalLatinTerms = extractLatinTerms(normalizedGoal);
  const goalCompact = normalizedGoal.replace(/[\s\p{P}\p{S}]/gu, "");
  const titledAppNames = new Set(
    targets
      .filter((target) => target.appName !== undefined && target.title !== undefined)
      .map((target) => normalizeWindowLabel(target.appName)),
  );
  // Automatic matching owns the policy of ignoring untitled siblings when a
  // titled identity exists for the same app. The CUA adapter deliberately
  // keeps real untitled sheets/dialogs in its inventory, so they remain
  // available to manual selection and explicit handoff. Distinct titled
  // windows remain separate candidates and therefore remain ambiguous.
  const matchableTargets = targets.filter((target) =>
    target.title !== undefined || target.appName === undefined || !titledAppNames.has(normalizeWindowLabel(target.appName)));

  if (explicitHint !== undefined) {
    const applicationMatches = matchableTargets.filter((target) => appNameHasExactTerm(target.appName ?? "", explicitHint));
    if (applicationMatches.length === 0) return { kind: "none" };
    if (applicationMatches.length === 1) return { kind: "matched", match: { target: applicationMatches[0]! } };
    const scopedGoalLatinTerms = goalLatinTerms.filter((term) => term !== explicitHint);
    const confidentWithinApplication = applicationMatches
      .map((target) => scoreTarget(target, normalizedGoal, titleMatchGoal, scopedGoalLatinTerms, goalCompact))
      .filter((candidate) => candidate.score >= MIN_CONFIDENT_SCORE);
    if (confidentWithinApplication.length === 1) {
      return { kind: "matched", match: { target: confidentWithinApplication[0]!.target } };
    }
    return { kind: "ambiguous" };
  }

  const confident = matchableTargets
    .map((target) => scoreTarget(target, normalizedGoal, titleMatchGoal, goalLatinTerms, goalCompact))
    .filter((candidate) => candidate.score >= MIN_CONFIDENT_SCORE);
  if (confident.length === 1) return { kind: "matched", match: { target: confident[0]!.target } };
  if (confident.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}

function explicitApplicationHint(goal: string): string | undefined {
  const chinesePrefix = chineseApplicationPlacement(goal);
  if (chinesePrefix !== undefined) return chinesePrefix.application;

  const explicitSwitchTarget = goal.match(/^switch\s+to\s+(?:the\s+)?([\p{Script=Latin}\p{Number}]+)/u)?.[1];
  if (explicitSwitchTarget !== undefined && !GOAL_ACTION_TERMS.has(explicitSwitchTarget)) return explicitSwitchTarget;

  const contextualEnglishTarget = goal.match(/\b(?:in|using)\s+(?:the\s+)?([\p{Script=Latin}\p{Number}]+)/u)?.[1];
  if (contextualEnglishTarget !== undefined && !GOAL_ACTION_TERMS.has(contextualEnglishTarget)) return contextualEnglishTarget;
  return undefined;
}

function leadingChineseAppTargetRemainder(goal: string): string | undefined {
  const prefix = chineseApplicationPlacement(goal);
  return prefix === undefined ? undefined : goal.slice(prefix.end).replace(/^(?:里面|里|中|上|内)/u, "");
}

function chineseApplicationPlacement(goal: string): { readonly application: string; readonly end: number } | undefined {
  // Normalize common request politeness before the placement phrase while
  // keeping the target syntax anchored at the start. In particular, "帮我在
  // WPS里" is an app constraint; a later mention such as "从WPS复制到记事本"
  // is not.
  const prefix = goal.match(/^(?:(?:请|麻烦)(?:帮我)?|帮我)?(?:切换到|访问|打开|查看|检查|使用|运行|在|用)\s*[\p{Script=Latin}\p{Number}]+/u)?.[0];
  if (prefix === undefined) return undefined;
  const application = prefix.match(/[\p{Script=Latin}\p{Number}]+$/u)?.[0];
  return application === undefined ? undefined : { application, end: prefix.length };
}

function appNameHasExactTerm(appName: string, term: string): boolean {
  return extractLatinTerms(appName).includes(term);
}

function normalizeWindowLabel(value: string | undefined): string {
  return value?.normalize("NFKC").trim().toLocaleLowerCase() ?? "";
}

function scoreTarget(
  target: WindowTargetInfo,
  normalizedGoal: string,
  titleMatchGoal: string,
  goalLatinTerms: readonly string[],
  goalCompact: string,
): ScoredWindowTarget {
  const appName = target.appName ?? "";
  const appLatinTerms = extractLatinTerms(appName);
  const titleIdentity = leadingTitleIdentity(target.title ?? "");
  const titleLatinTerms = extractLatinTerms(titleIdentity);
  const appHanTerms = extractAppHanTerms(appName);
  const titleHanTerms = extractSpecificHanTerms(titleIdentity);

  const matchedFullAppLatin = isSpecificLatinIdentity(appLatinTerms) && includesWholePhrase(goalLatinTerms, appLatinTerms);
  const matchedAppSuffix = !matchedFullAppLatin && hasDistinctiveTrailingAppIdentity(goalLatinTerms, appLatinTerms);
  const matchedTitleLatin = hasCompleteTitleIdentity(titleLatinTerms, goalLatinTerms);
  const matchedAppHan = appHanTerms.filter((term) => containsBoundedHanIdentity(normalizedGoal, term));
  // Two-character Han titles are common words and need explicit boundaries;
  // longer extracted title identities keep the existing substring behavior
  // so user verbs before them and known suffix context after them still match.
  const matchedTitleHan = titleHanTerms.filter((term) => term.length <= 2
    ? containsBoundedHanIdentity(titleMatchGoal, term)
    : goalCompact.includes(term));

  const score =
    (matchedFullAppLatin ? latinIdentityScore(appLatinTerms) : 0) +
    (matchedAppSuffix ? Math.min(appLatinTerms.at(-1)!.length, 8) : 0) +
    (matchedTitleLatin ? latinIdentityScore(titleLatinTerms) : 0) +
    matchedAppHan.reduce((total, term) => total + 2 + Math.min(term.length, 6), 0) +
    matchedTitleHan.reduce((total, term) => total + 2 + Math.min(term.length, 6), 0);
  return { target, score };
}

function extractLatinTerms(value: string): string[] {
  return (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{Script=Latin}\p{Number}]+/gu) ?? []);
}

function isSpecificLatinIdentity(terms: readonly string[]): boolean {
  return terms.length > 0 && !terms.every((term) => GENERIC_LATIN_TERMS.has(term));
}

function hasCompleteTitleIdentity(titleTerms: readonly string[], goalTerms: readonly string[]): boolean {
  const titleIdentityTerms = titleTerms.filter((term) => !GENERIC_LATIN_TERMS.has(term));
  if (titleIdentityTerms.length === 0) return false;
  const goalIdentityTerms = goalTerms.filter((term) => !GENERIC_LATIN_TERMS.has(term) && !GOAL_ACTION_TERMS.has(term));
  return goalIdentityTerms.length === titleIdentityTerms.length &&
    goalIdentityTerms.every((term, index) => term === titleIdentityTerms[index]) &&
    includesWholePhrase(goalTerms, titleTerms);
}

function hasDistinctiveTrailingAppIdentity(goalTerms: readonly string[], appTerms: readonly string[]): boolean {
  if (appTerms.length < 2) return false;
  const trailingTerm = appTerms.at(-1)!;
  if (trailingTerm.length < 5 || GENERIC_LATIN_TERMS.has(trailingTerm)) return false;
  const goalIdentityTerms = goalTerms.filter((term) => !GENERIC_LATIN_TERMS.has(term) && !GOAL_ACTION_TERMS.has(term));
  return goalIdentityTerms.length === 1 && goalIdentityTerms[0] === trailingTerm;
}

function includesWholePhrase(haystack: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - phrase.length; start += 1) {
    if (phrase.every((term, offset) => haystack[start + offset] === term)) return true;
  }
  return false;
}

function latinIdentityScore(terms: readonly string[]): number {
  return terms.reduce((total, term) => total + Math.min(term.length, 8), 0);
}

function extractSpecificHanTerms(value: string): string[] {
  const phrases = value.normalize("NFKC").match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const specific = new Set<string>();
  for (const phrase of phrases) {
    let core = phrase;
    while (core.length > 1) {
      let changed = false;
      for (const prefix of HAN_TITLE_PREFIXES) {
        if (core.startsWith(prefix) && core.length > prefix.length) {
          core = core.slice(prefix.length);
          changed = true;
          break;
        }
      }
      if (changed) continue;
      for (const suffix of [...HAN_TITLE_SUFFIXES].sort((left, right) => right.length - left.length)) {
        if (core.endsWith(suffix) && core.length > suffix.length) {
          core = core.slice(0, -suffix.length);
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    if (core.length >= 2 && !HAN_TITLE_SUFFIXES.includes(core)) specific.add(core);
  }
  return [...specific];
}

function extractAppHanTerms(value: string): string[] {
  const phrases = value.normalize("NFKC").match(/[\p{Script=Han}]{2,}/gu) ?? [];
  return phrases.filter((phrase) => !GENERIC_HAN_APP_NAMES.has(phrase));
}

function containsBoundedHanIdentity(goal: string, identity: string): boolean {
  let candidate = goal;
  for (const prefix of HAN_IDENTITY_ACTION_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  candidate = candidate.replace(/[\s\p{P}\p{S}]/gu, "");
  const position = candidate.indexOf(identity);
  if (position < 0) return false;
  const before = [...candidate.slice(0, position)].at(-1);
  const after = candidate.slice(position + identity.length)[0];
  const beforeIsHan = before !== undefined && /\p{Script=Han}/u.test(before);
  const afterIsHan = after !== undefined && /\p{Script=Han}/u.test(after);
  const remainder = candidate.slice(position + identity.length);
  // Keep common compound nouns from being mistaken for standalone location
  // particles (for example “设置中心” is not “在设置中”).
  if (remainder.startsWith("中心")) return false;
  const recognizedContinuation = HAN_IDENTITY_CONNECTORS.some((connector) => remainder.startsWith(connector)) ||
    HAN_TITLE_SUFFIXES.some((suffix) => remainder.startsWith(suffix));
  return !beforeIsHan && (!afterIsHan || recognizedContinuation);
}

function leadingTitleIdentity(value: string): string {
  return value.normalize("NFKC").split(/[|｜–—\-:：·]/u, 1)[0] ?? value;
}

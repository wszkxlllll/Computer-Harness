export type RiskProfile = "experiment" | "live-interactive";
export type RiskGuardMode = "off" | "layered";

export interface ResolvedRiskConfig {
  profile: RiskProfile;
  riskGuard: RiskGuardMode;
}

export interface ResolveRiskConfigInput {
  profile?: string;
  riskGuard?: string;
  interactive?: boolean;
  tui?: boolean;
  confirmRiskGuardOff?: boolean;
}

/**
 * Resolve the one risk configuration consumed by CLI construction, summaries,
 * and the TUI.  Experiment/evaluation runs retain an explicit off switch;
 * interactive runs default to layered protection and require confirmation to
 * disable it.
 */
export function resolveRiskConfig(input: ResolveRiskConfigInput = {}): ResolvedRiskConfig {
  const interactive = input.tui === true || input.interactive === true;
  const profile = normalizeRiskProfile(input.profile, interactive);
  const requestedGuard = input.riskGuard === undefined ? undefined : normalizeRiskGuard(input.riskGuard);
  const riskGuard = requestedGuard ?? (profile === "live-interactive" ? "layered" : "off");
  if ((interactive || profile === "live-interactive") && riskGuard === "off" && input.confirmRiskGuardOff !== true) {
    throw new Error("disabling Risk Guard for live-interactive requires --confirm-risk-guard-off");
  }
  return { profile, riskGuard };
}

function normalizeRiskProfile(value: string | undefined, interactive: boolean): RiskProfile {
  if (value === undefined) return interactive ? "live-interactive" : "experiment";
  if (value === "experiment" || value === "fixture" || value === "evaluation") return "experiment";
  if (value === "live-interactive" || value === "live") return "live-interactive";
  throw new Error("--profile must be experiment or live-interactive");
}

function normalizeRiskGuard(value: string): RiskGuardMode {
  if (value === "off" || value === "layered") return value;
  throw new Error("--risk-guard must be off or layered");
}

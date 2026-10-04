import type { Policy } from "./config";
import type { Evaluation } from "./evaluator";
import type { Decision } from "./model";

export function dateOf(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export function settledSuccess(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    value.state === "success" &&
    "phase" in value &&
    value.phase === "passed"
  );
}

export function pending(
  decision: Decision,
  reason: string,
  blockers: string[],
): Decision {
  return {
    ...decision,
    state: "pending",
    phase: "discovery",
    reason,
    blockers,
  };
}

export function isEmptyEvaluation(decision: Decision): boolean {
  return (
    decision.state === "pending" &&
    decision.phase === "discovery" &&
    decision.applicable === 0
  );
}

export type DiscoveryProgress = {
  fingerprint: string | null;
  stableSince: Date | null;
  emptyScans: number;
  emptyNext: Date | null;
};

// Event overlays can change readiness, but only due authoritative reads advance
// the empty-check policy. Persist the returned progress in the caller's lock scope.
export function advanceDiscovery(
  previous: DiscoveryProgress,
  evaluation: Evaluation,
  policy: Policy,
  now: Date,
  retrySeconds: number,
  authoritative: boolean,
) {
  const stableSince =
    previous.fingerprint === evaluation.fingerprint
      ? (previous.stableSince ?? now)
      : now;
  const empty = isEmptyEvaluation(evaluation);
  let emptyScans = previous.emptyScans;
  if (!empty) emptyScans = 0;
  else if (
    authoritative &&
    (!previous.emptyNext || now.getTime() >= previous.emptyNext.getTime())
  )
    emptyScans++;
  const emptyNext = empty
    ? authoritative
      ? new Date(now.getTime() + retrySeconds * 1000)
      : previous.emptyNext
    : null;
  let decision: Decision = evaluation;
  if (empty) {
    decision =
      policy.empty_checks.policy === "pass_after_attempts" &&
      emptyScans >= policy.empty_checks.pass_after_attempts
        ? {
            ...evaluation,
            state: "success",
            phase: "passed",
            reason: `No eligible checks: passed after ${emptyScans} complete scheduled empty scans`,
            blockers: [],
          }
        : pending(evaluation, "Discovering checks", [
            policy.empty_checks.policy === "block"
              ? "Empty-check policy blocks success"
              : `${emptyScans}/${policy.empty_checks.pass_after_attempts} complete scheduled empty scans`,
          ]);
  }
  return { stableSince, emptyScans, emptyNext, decision };
}

export function stabilityRemaining(
  policy: Policy,
  windowStart: Date,
  stableSince: Date,
  now: Date,
): number {
  return Math.max(
    0,
    policy.reconciliation.initial_grace_seconds * 1000 -
      (now.getTime() - windowStart.getTime()),
    policy.reconciliation.quiet_period_seconds * 1000 -
      (now.getTime() - stableSince.getTime()),
  );
}

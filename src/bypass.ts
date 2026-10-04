import { sql } from "drizzle-orm";
import type { Policy } from "./config";
import type { Database } from "./db";
import type { GitHub } from "./github";
import {
  BYPASS_LABEL,
  type Decision,
  type PullRequest,
  type Target,
  targetKey,
} from "./model";
import { peersFor } from "./shared-head";

// Apply a verified grant without weakening another PR that shares this SHA.
export async function applyBypass(
  tx: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  p: PullRequest,
  row: Record<string, unknown>,
  policy: Policy,
  decision: Decision,
): Promise<Decision> {
  const key = targetKey(t);
  if (!p.labels.includes(BYPASS_LABEL))
    await tx.execute(
      sql`UPDATE warden_prs SET bypass_actor=NULL,bypass_sha=NULL,bypass_application_id=NULL WHERE key=${key}`,
    );
  if (
    p.labels.includes(BYPASS_LABEL) &&
    typeof row.bypass_actor === "string" &&
    row.bypass_sha === p.sha
  ) {
    const application = await github.labelApplication(t, BYPASS_LABEL);
    const permission = await github.permission(t, row.bypass_actor);
    if (
      application &&
      application.id === row.bypass_application_id &&
      application.actor === row.bypass_actor &&
      policy.bypass.allowed_permissions.some((value) => value === permission)
    ) {
      const peers = await peersFor(tx, github, t, p.sha);
      if (peers.length === 1 && peers[0] === t.number) {
        decision = {
          ...decision,
          state: "success",
          phase: "bypassed",
          reason: `Bypassed via skip warden by ${row.bypass_actor}`,
          blockers: [],
        };
      } else {
        // A label cannot weaken a peer's gate. Normal verified evaluation
        // remains available when every subject passes without bypass.
        decision = {
          ...decision,
          reason: `${decision.reason}; bypass unavailable on a shared head`,
          blockers:
            decision.state === "success"
              ? []
              : [
                  ...decision.blockers,
                  "A shared head cannot be bypassed independently",
                ],
        };
      }
    }
  } else if (p.labels.includes(BYPASS_LABEL))
    decision = {
      ...decision,
      blockers: [
        ...decision.blockers,
        "skip warden has no verified grant for this PR/head; normal evaluation applies",
      ],
    };
  return decision;
}

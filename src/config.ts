import { parse } from "yaml";
import { z } from "zod";

const workflowMatch = z.union([
  z.object({ id: z.number().int().positive() }).strict(),
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ name: z.string().min(1) }).strict(),
]);
const policy = z
  .object({
    version: z.literal(1).default(1),
    checks: z
      .object({
        passing_conclusions: z
          .array(z.enum(["success", "neutral", "skipped"]))
          .min(1)
          .default(["success", "neutral", "skipped"]),
        ignore_checks: z.array(z.string().min(1)).default([]),
        ignore_statuses: z.array(z.string().min(1)).default([]),
        ignore_workflows: z.array(workflowMatch).default([]),
      })
      .strict()
      .default({
        passing_conclusions: ["success", "neutral", "skipped"],
        ignore_checks: [],
        ignore_statuses: [],
        ignore_workflows: [],
      }),
    reconciliation: z
      .object({
        intervals_seconds: z
          .array(z.number().int().min(1).max(3600))
          .min(1)
          .max(20)
          .default([30, 60, 120, 300]),
        max_duration_seconds: z.number().int().min(1).max(86400).default(21600),
        initial_grace_seconds: z.number().int().min(0).max(300).default(10),
        quiet_period_seconds: z.number().int().min(1).max(300).default(5),
      })
      .strict()
      .default({
        intervals_seconds: [30, 60, 120, 300],
        max_duration_seconds: 21600,
        initial_grace_seconds: 10,
        quiet_period_seconds: 5,
      }),
    empty_checks: z
      .object({
        policy: z
          .enum(["pass_after_attempts", "block"])
          .default("pass_after_attempts"),
        pass_after_attempts: z.number().int().min(1).max(100).default(3),
      })
      .strict()
      .default({ policy: "pass_after_attempts", pass_after_attempts: 3 }),
    bypass: z
      .object({
        label: z.literal("skip warden").default("skip warden"),
        allowed_permissions: z
          .array(z.enum(["write", "maintain", "admin"]))
          .min(1)
          .default(["write", "maintain", "admin"]),
      })
      .strict()
      .default({
        label: "skip warden",
        allowed_permissions: ["write", "maintain", "admin"],
      }),
    comment: z
      .object({
        enabled: z.boolean().default(true),
        min_update_interval_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(5),
      })
      .strict()
      .default({ enabled: true, min_update_interval_seconds: 5 }),
  })
  .strict();
export type Policy = z.infer<typeof policy>;
export function parsePolicy(contents: string | null): Policy {
  if (contents === null) return policy.parse({});
  if (contents.length > 65536)
    throw new Error("Warden configuration exceeds 64 KiB");
  return policy.parse(parse(contents, { maxAliasCount: 20 }));
}
export const defaultPolicy = parsePolicy(null);

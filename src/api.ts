import type { Webhooks } from "@octokit/webhooks";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "./db";
import { ingest } from "./db/queue";
export function createApi(db: Database, webhooks?: Pick<Webhooks, "verify">) {
  const app = new Hono();
  app.get("/live", (c) => c.json({ status: "ok", service: "warden-api" }));
  app.get("/ready", async (c) => {
    try {
      await db.execute(sql`SELECT 1`);
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });
  app.get("/metrics", async (c) => {
    const metrics = await db.execute(
      sql`SELECT name,value FROM warden_metrics ORDER BY name`,
    );
    const queue = await db.execute(
      sql`SELECT count(*) FILTER (WHERE NOT completed AND NOT dead) AS pending,count(*) FILTER (WHERE dead) AS dead,greatest(0,coalesce(max(extract(epoch from now()-available_at)) FILTER (WHERE NOT completed AND NOT dead),0)) AS lag_seconds FROM warden_jobs`,
    );
    return c.json({ metrics, queue: queue[0] });
  });
  app.get("/health", async (c) => {
    await db.execute(sql`SELECT 1`);
    return c.json({ status: "ok", service: "warden-api" });
  });
  if (webhooks) {
    app.use(
      "/webhooks/github",
      bodyLimit({
        maxSize: 2 * 1024 * 1024,
        onError: (c) => {
          // The rejected request can have unread bytes. Do not reuse that HTTP/1
          // connection for the next webhook; Bun/Linux otherwise sees stale data.
          c.header("Connection", "close");
          return c.json({ error: "Webhook body exceeds 2 MiB" }, 413);
        },
      }),
    );
    app.post("/webhooks/github", async (c) => {
      const body = await c.req.text();
      const signature = c.req.header("x-hub-signature-256");
      if (!body || !signature || !(await webhooks.verify(body, signature)))
        return c.json({ error: "Invalid signature" }, 401);
      const id = c.req.header("x-github-delivery");
      const event = c.req.header("x-github-event");
      if (!id || id.length > 200 || !event || event.length > 100)
        return c.json({ error: "Missing or invalid delivery headers" }, 400);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      )
        return c.json({ error: "Expected object" }, 400);
      const accepted = await ingest(
        db,
        id,
        event,
        redact(payload) as Record<string, unknown>,
      );
      console.log(
        JSON.stringify({
          service: "warden-api",
          event: "delivery_accepted",
          delivery: id,
          type: event,
          duplicate: !accepted,
        }),
      );
      return c.json({ accepted, delivery: id }, 202);
    });
  }
  app.onError((error, c) => {
    console.error("Warden API request failed", error.message);
    return c.json({ error: "Request failed; retry delivery" }, 500);
  });
  return app;
}

const sensitive = new Set([
  "authorization",
  "proxyauthorization",
  "accesstoken",
  "refreshtoken",
  "installationtoken",
  "githubtoken",
  "token",
  "privatekey",
  "webhooksecret",
  "secret",
  "password",
  "clientsecret",
  "apikey",
  "databaseurl",
  "wardenprivatekey",
  "wardenwebhooksecret",
  "wardenpostgrespassword",
]);
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitive.has(key.replace(/[-_]/g, "").toLowerCase())
          ? "[REDACTED]"
          : redact(entry),
      ]),
    );
  return value;
}

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { connect } from "./index";
export async function migrate(url: string) {
  const { db, close } = connect(url);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(18743001)`);
      await tx.execute(
        sql`CREATE TABLE IF NOT EXISTS warden_migrations (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const directory =
        process.env.WARDEN_MIGRATIONS_DIR ?? join(process.cwd(), "migrations");
      for (const filename of (await readdir(directory))
        .filter((name) => /^\d{4}_[a-z_]+\.sql$/.test(name))
        .sort()) {
        const name = filename.replace(/\.sql$/, "");
        const contents = await Bun.file(join(directory, filename)).text();
        const hash = createHash("sha256").update(contents).digest("hex");
        const found = await tx.execute(
          sql`SELECT name,hash FROM warden_migrations WHERE name=${name}`,
        );
        if (found[0] && found[0].hash !== hash)
          throw new Error(
            "Applied Warden migration checksum differs; create a new migration instead of editing applied SQL",
          );
        if (!found.length) {
          await tx.execute(sql.raw(contents));
          await tx.execute(
            sql`INSERT INTO warden_migrations(name,hash) VALUES (${name},${hash})`,
          );
        }
      }
    });
  } finally {
    await close();
  }
}
if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await migrate(process.env.DATABASE_URL);
  console.log("Warden migrations applied");
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
export function connect(url: string) {
  const client = postgres(url, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  return {
    db: drizzle(client),
    close: () => client.end({ timeout: 5 }),
  };
}
export type Database = ReturnType<typeof connect>["db"];

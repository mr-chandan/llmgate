import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import { config } from "../config.js";
import * as schema from "./schema.js";

const sqlite = new Database(config.DATABASE_URL);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function runMigrations(): void {
  migrate(db, { migrationsFolder: resolve("drizzle") });
}

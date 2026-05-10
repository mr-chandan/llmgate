import "dotenv/config";
import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return ["true", "1", "yes", "on"].includes(v.toLowerCase());
  });

const ConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GROQ_API_KEY: z.string().min(1).optional(),

  DATABASE_URL: z.string().default("./dev.sqlite"),

  // Resilience knobs
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(2),
  PROVIDER_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  PROVIDER_RETRY_MAX_MS: z.coerce.number().int().positive().default(4_000),
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_WINDOW_MS: z.coerce.number().int().positive().default(30_000),
  CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(30_000),

  // Failure-injection provider (Step 14). Off by default.
  ENABLE_CHAOS: boolish.default(false),

  // Admin REST API key. If unset, /admin/* returns 503.
  ADMIN_API_KEY: z.string().min(1).optional(),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

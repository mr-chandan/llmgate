import "dotenv/config";
import { z } from "zod";

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
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.format());
    process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

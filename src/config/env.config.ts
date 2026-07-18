import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

/**
 * Identify the current execution environment (defaults to 'development').
 * We will load the matching configuration file (.env, .env.development, .env.test).
 */
const nodeEnv = process.env.NODE_ENV || "development";

const envFile = 
  nodeEnv === "test"
    ? ".env.test"
    : nodeEnv === "development"
      ? ".env.development"
      : ".env";

// Resolve full absolute path to the targeted env file and configure dotenv
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

/** 
 * Zod Schema for Environment Variables validation.
 * This guarantees strict checking:
 *  - PORT: Coerced into a number, defaults to 3000 if absent.
 *  - NODE_ENV: Strict enum to prevent typos in env configurations.
 *  - MONGO_URI: Must be a valid URI.
 *  - CORS_ORIGIN: Defaults to '*' (broad access) but configurable.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  MONGO_URI: z
    .string()
    .url({ message: "MONGO_URI must be a valid connection URL." }),
  CORS_ORIGIN: z.string().default("*"),
});

// Perform validation against the global process.env object
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error(
    "❌ Environment configuration error. The following variables are invalid or missing:"
  );
  console.error(JSON.stringify(parsedEnv.error.format(), null, 2));

  // Shutdown process immediately. Running with bad configurations in production is high risk.
  process.exit(1);
}

/**
 * Strictly-typed parsed environment object.
 * Import this throughout the application instead of raw `process.env`.
 */
export const env = parsedEnv.data;

// Export the type of parsed environment for TS reference
export type EnvConfigType = z.infer<typeof envSchema>;

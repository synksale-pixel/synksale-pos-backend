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
    ? ".env.test.local"
    : nodeEnv === "development"
      ? ".env.development.local"
      : ".env";

// Resolve full absolute path to the targeted env file and configure dotenv
const dotenvResult = dotenv.config({
  path: path.resolve(process.cwd(), envFile),
});
if (dotenvResult.error) {
  console.warn(
    `⚠️ Warning: Could not load environment file ${envFile}:`,
    dotenvResult.error.message
  );
}

/**
 * Zod Schema for Environment Variables validation.
 * This guarantees strict checking:
 *  - PORT: Coerced into a number, defaults to 3000 if absent.
 *  - NODE_ENV: Strict enum to prevent typos in env configurations.
 *  - MONGO_URI: Must be a valid URI.
 *  - CORS_ORIGIN: Defaults to '*' (broad access) but configurable.
 */
const envSchema = z
  .object({
    // ===== App Config =====
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    MONGO_URI: z
      .string()
      .url({ message: "MONGO_URI must be a valid connection URL." }),
    CORS_ORIGIN: z.string().default("*"),

    // ===== JWT Config =====
    // JWT_ACCESS_SECRET must be at least 32 characters long for proper security strength.
    // Short secrets make HMAC tokens vulnerable to brute-force or precomputation attacks.
    JWT_ACCESS_SECRET: z.string().min(32, {
      message: "JWT_ACCESS_SECRET must be at least 32 characters long.",
    }),
    JWT_ACCESS_EXPIRY: z.string().default("15m"),
    // JWT_REFRESH_SECRET must be different from JWT_ACCESS_SECRET. If an access key is leaked,
    // refresh tokens are still secure because they are signed/validated with a different secret.
    JWT_REFRESH_SECRET: z.string().min(32, {
      message: "JWT_REFRESH_SECRET must be at least 32 characters long.",
    }),
    JWT_REFRESH_EXPIRY: z.string().default("7d"),

    // ===== JWT Platform Config (Super Admin) =====
    // JWT_PLATFORM_SECRET must be at least 32 characters long.
    JWT_PLATFORM_SECRET: z.string().min(32, {
      message: "JWT_PLATFORM_SECRET must be at least 32 characters long.",
    }),
    // Platform-level access tokens should have a tighter expiry given the blast radius of compromise.
    JWT_PLATFORM_ACCESS_EXPIRY: z.string().default("10m"),
    // Shorter refresh expiry than tenant tokens for same reason.
    JWT_PLATFORM_REFRESH_EXPIRY: z.string().default("3d"),

    // ===== CLI Seed Config =====
    // These are optional. Only for local bootstrap convenience, never relied on in production.
    SUPER_ADMIN_SEED_EMAIL: z.string().email().optional(),
    SUPER_ADMIN_SEED_PASSWORD: z.string().min(8).optional(),

    // ===== API Config =====
    API_VERSION: z.string().default("v1"),

    // ===== Feature Flags =====
    FEATURE_MULTI_CURRENCY: z
      .preprocess((val) => {
        if (val === "true" || val === "1") return true;
        if (val === "false" || val === "0") return false;
        return val;
      }, z.boolean())
      .default(false),
    FEATURE_ADVANCED_TAX_RULES: z
      .preprocess((val) => {
        if (val === "true" || val === "1") return true;
        if (val === "false" || val === "0") return false;
        return val;
      }, z.boolean())
      .default(false),

    // ===== Logging Configuration =====
    LOG_LEVEL: z
      .enum(["error", "warn", "info", "http", "debug"])
      .default(process.env.NODE_ENV === "production" ? "info" : "debug"),
    LOG_TO_FILE: z
      .preprocess((val) => {
        if (val === "true" || val === "1") return true;
        if (val === "false" || val === "0") return false;
        return val;
      }, z.boolean())
      .default(process.env.NODE_ENV === "production"),
  })
  .refine((data) => data.JWT_ACCESS_SECRET !== data.JWT_REFRESH_SECRET, {
    message: "JWT_REFRESH_SECRET must be different from JWT_ACCESS_SECRET.",
    path: ["JWT_REFRESH_SECRET"],
  })
  .refine((data) => data.JWT_PLATFORM_SECRET !== data.JWT_ACCESS_SECRET, {
    message: "JWT_PLATFORM_SECRET must be different from JWT_ACCESS_SECRET.",
    path: ["JWT_PLATFORM_SECRET"],
  })
  .refine((data) => data.JWT_PLATFORM_SECRET !== data.JWT_REFRESH_SECRET, {
    message: "JWT_PLATFORM_SECRET must be different from JWT_REFRESH_SECRET.",
    path: ["JWT_PLATFORM_SECRET"],
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

console.log(`✅ Environment variables loaded successfully from ${envFile}`);

/**
 * Strictly-typed parsed environment object.
 * Import this throughout the application instead of raw `process.env`.
 */
export const env = parsedEnv.data;

// Export the type of parsed environment for TS reference
export type EnvConfigType = z.infer<typeof envSchema>;

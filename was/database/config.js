import { env } from "node:process";
import { readFileSync } from "node:fs";
import { absolute } from "#was/core/path.js";

export const defaults = Object.freeze({
  DB_ENABLED: "false",
  DB_HOST: "",
  DB_PORT: "5432",
  DB_NAME: "",
  DB_USER: "",
  DB_PASSWORD: "",
  DB_SSL: "true",
  DB_CA: "",
  DB_POOL: "10",
  DB_TIMEOUT: "5000",
});

export function config() {
  const enabled = env.DB_ENABLED ?? defaults.DB_ENABLED;

  let valid = enabled !== "true";

  if (valid) {
    valid = enabled !== "false";
  }

  if (valid) {
    throw new Error("DATABASE_CONFIG: DB_ENABLED must be true or false.");
  }

  if (enabled === "false") {
    return null;
  }

  for (const name of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    if (!env[name]) {
      throw new Error(`DATABASE_CONFIG: ${name} is required.`);
    }
  }

  const mode = env.DB_SSL ?? defaults.DB_SSL;

  let ssl;

  if (mode === "true") {
    ssl = { rejectUnauthorized: true };

    if (env.DB_CA) {
      if (!absolute(env.DB_CA)) {
        throw new Error("DATABASE_CONFIG: DB_CA must be an absolute path.");
      }

      try {
        ssl.ca = readFileSync(env.DB_CA, "utf8");
      } catch (error) {
        throw new Error("DATABASE_CONFIG: Could not read the DB CA file.", {
          cause: error,
        });
      }
    }
  } else if (mode === "false") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_CONFIG: Production DB connections require TLS.",
      );
    }

    ssl = false;
  } else {
    throw new Error("DATABASE_CONFIG: DB_SSL must be true or false.");
  }

  const port = integer("DB_PORT", 65535);
  const max = integer("DB_POOL", 100);
  const timeout = integer("DB_TIMEOUT", 2147483647);
  const host = env.DB_HOST;
  const database = env.DB_NAME;
  const user = env.DB_USER;
  const password = env.DB_PASSWORD;

  const settings = {
    host,
    port,
    database,
    user,
    password,
    ssl,
    max,
    connectionTimeoutMillis: timeout,
    idleTimeoutMillis: 30000,
    statement_timeout: timeout,
    query_timeout: timeout,
    idle_in_transaction_session_timeout: timeout,
    application_name: "orbit",
  };

  return settings;
}

function integer(name, limit) {
  const text = env[name] ?? defaults[name];
  const number = Number(text);
  const digits = /^\d+$/.test(text);

  let range = number >= 1;

  if (range) {
    range = number <= limit;
  }

  let valid = !digits;

  if (!valid) {
    valid = !range;
  }

  if (valid) {
    throw new Error(`DATABASE_CONFIG: ${name} must be between 1 and ${limit}.`);
  }

  return number;
}

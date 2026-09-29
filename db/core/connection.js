import * as fs from "node:fs/promises";
import * as process from "node:process";
import pg from "pg";
import * as path from "#db/core/path.js";
import * as environment from "#db/core/environment.js";
import { defaults } from "#db/core/config.js";

function integer(name, limit) {
  const text = process.env[name] ?? defaults[name];
  const value = Number(text);
  const digits = /^\d+$/.test(text);
  const minimum = value > 0;
  const maximum = value <= limit;
  const valid = digits && minimum && maximum;

  if (!valid) {
    throw new Error(`MIGRATION_CONFIG: Invalid ${name}.`);
  }

  return value;
}

export async function config() {
  environment.load(defaults, "MIGRATION_CONFIG");

  const enabled = process.env.DB_ENABLED ?? defaults.DB_ENABLED;

  if (enabled !== "true") {
    throw new Error("MIGRATION_CONFIG: Database connection is not enabled.");
  }

  for (const name of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    const value = process.env[name];

    if (!value?.trim()) {
      throw new Error(`MIGRATION_CONFIG: Missing ${name}.`);
    }
  }

  let ssl = { rejectUnauthorized: true };

  const mode = process.env.DB_SSL ?? defaults.DB_SSL;

  if (mode === "true") {
    const filename = process.env.DB_CA;

    if (filename) {
      if (!path.absolute(filename)) {
        throw new Error("MIGRATION_CONFIG: Use an absolute CA path.");
      }

      ssl.ca = await fs.readFile(filename, "utf8");
    }
  } else if (mode === "false") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MIGRATION_CONFIG: Production requires TLS.");
    }

    ssl = false;
  } else {
    throw new Error("MIGRATION_CONFIG: Invalid TLS setting.");
  }

  const host = process.env.DB_HOST;
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const port = integer("DB_PORT", 65535);
  const timeout = integer("DB_TIMEOUT", 2147483647);
  const duration = integer("DB_MIGRATION_TIMEOUT", 2147483647);

  const settings = {
    host,
    port,
    database,
    user,
    password,
    ssl,
    connectionTimeoutMillis: timeout,
    query_timeout: duration,
    statement_timeout: duration,
    idle_in_transaction_session_timeout: duration,
    application_name: "orbit-migration",
  };

  return settings;
}

export async function open(settings) {
  const client = new pg.Client(settings);

  let failure;

  client.on("error", (error) => {
    failure = error;
  });

  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);

    throw new Error("MIGRATION_CONNECT: Connection failed.", { cause: error });
  }

  async function query(text, values = []) {
    if (failure) {
      throw new Error("MIGRATION_CONNECT: Connection lost.", {
        cause: failure,
      });
    }

    return await client.query(text, values);
  }

  async function close() {
    await client.end();
  }

  const connection = { query, close };

  return connection;
}

import { performance } from "node:perf_hooks";
import pg from "pg";
import { Console } from "node:console";
import process from "node:process";

const log = new Console(process.stdout, process.stderr);

let pool;
let closing = false;
let ending;

export function initialize(settings) {
  if (pool || closing) {
    throw new Error(
      "DATABASE_POOL: The database lifecycle has already started.",
    );
  }

  if (!settings) {
    return;
  }

  pool = new pg.Pool(settings);

  pool.on("error", failure);
}

function failure() {
  log.error("DATABASE_CONNECTION: An idle database connection was lost.");
}

function available() {
  if (closing) {
    throw new Error("DATABASE_CLOSED: The database pool is shutting down.");
  }

  if (!pool) {
    throw new Error("DATABASE_CONFIG: The database connection is not enabled.");
  }
}

function statement(text, values) {
  let valid = typeof text === "string";

  if (valid) {
    valid = text.trim();
  }

  if (valid) {
    valid = Array.isArray(values);
  }

  if (!valid) {
    throw new Error("DATABASE_QUERY: Supply SQL text and a parameter array.");
  }
}

export async function query(text, values = []) {
  available();

  statement(text, values);

  try {
    return await pool.query(text, values);
  } catch (error) {
    throw new Error("DATABASE_QUERY: The database query could not complete.", {
      cause: error,
    });
  }
}

export async function transaction(operation) {
  available();

  if (typeof operation !== "function") {
    throw new Error("DATABASE_TRANSACTION: Supply a transaction function.");
  }

  let client;

  try {
    client = await pool.connect();
  } catch (error) {
    throw new Error(
      "DATABASE_CONNECT: Could not acquire a database connection.",
      { cause: error },
    );
  }

  let destroy = false;
  let active = true;
  let rejected;

  client.on("error", damaged);

  function damaged() {
    destroy = true;

    log.error("DATABASE_CONNECTION: A transaction connection was lost.");
  }

  async function execute(text, values = []) {
    if (!active) {
      throw new Error("DATABASE_TRANSACTION: This transaction has finished.");
    }

    statement(text, values);

    try {
      return await client.query(text, values);
    } catch (error) {
      rejected = error;

      throw error;
    }
  }

  try {
    await client.query("BEGIN");

    const result = await operation(execute);

    active = false;

    if (rejected) {
      throw rejected;
    }

    if (destroy) {
      throw new Error(
        "DATABASE_TRANSACTION: The transaction connection was lost.",
      );
    }

    await client.query("COMMIT");

    return result;
  } catch (error) {
    active = false;

    try {
      await client.query("ROLLBACK");
    } catch (rollback) {
      destroy = true;

      throw new AggregateError(
        [error, rollback],
        "DATABASE_TRANSACTION: The transaction and rollback both failed.",
        { cause: rollback },
      );
    }

    throw error;
  } finally {
    active = false;

    client.removeListener("error", damaged);

    client.release(destroy);
  }
}

export async function status() {
  if (closing) {
    const report = { state: "closed" };

    return report;
  }

  if (!pool) {
    const report = { state: "unconfigured" };

    return report;
  }

  try {
    const started = performance.now();

    const reply = await query(
      "SELECT pg_is_in_recovery() AS recovery, current_setting('transaction_read_only') AS readonly",
    );

    const row = reply.rows[0];
    const primary = row?.recovery === false;
    const writable = row?.readonly === "off";
    const ready = primary && writable;

    if (!ready) {
      const report = { state: "unavailable" };

      return report;
    }

    const latency = performance.now() - started;
    const report = { state: "ready", latency };

    return report;
  } catch {
    const report = { state: "unavailable" };

    return report;
  }
}

export function close() {
  if (ending) {
    return ending;
  }

  closing = true;

  if (pool) {
    ending = pool.end();
  } else {
    ending = Promise.resolve();
  }

  return ending;
}

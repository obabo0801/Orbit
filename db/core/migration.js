import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as connection from "#db/core/connection.js";
import * as sql from "#db/core/sql.js";

const pattern = /^\d{4}-[a-z][a-z0-9-]*\.sql$/u;
const key = [1330790985, 1];

async function files(directory) {
  const listing = await fs.readdir(directory, { withFileTypes: true });
  const entries = [];
  const numbers = new Set();

  for (const item of listing) {
    if (item.name === ".gitkeep") {
      continue;
    }

    const named = pattern.test(item.name);
    const regular = item.isFile();
    const valid = named && regular;

    if (!valid) {
      throw new Error("MIGRATION_FILE: Invalid migration file.");
    }

    const id = item.name.slice(0, -4);
    const number = id.slice(0, 4);

    if (numbers.has(number)) {
      throw new Error("MIGRATION_FILE: Duplicate migration number.");
    }

    numbers.add(number);

    const filename = path.join(directory, item.name);
    const buffer = await fs.readFile(filename);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const text = buffer.toString("utf8");
    const commands = sql.statements(text);

    if (!commands.length) {
      throw new Error("MIGRATION_FILE: Empty migration file.");
    }

    entries.push({ id, hash, commands });
  }

  entries.sort((left, right) => left.id.localeCompare(right.id, "en"));

  return entries;
}

async function lock(client, timeout) {
  const end = Date.now() + timeout;

  while (true) {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS held",
      key,
    );

    if (result.rows[0].held) {
      return;
    }

    if (Date.now() >= end) {
      throw new Error("MIGRATION_LOCK: Lock timeout.");
    }

    await delay(Math.min(100, end - Date.now()));
  }
}

async function prepare(client) {
  const lines = [
    "CREATE TABLE IF NOT EXISTS public.orbit_migration (",
    "id text PRIMARY KEY,",
    "hash text NOT NULL,",
    "time timestamptz NOT NULL DEFAULT clock_timestamp()",
    ")",
  ];

  await client.query("BEGIN");

  try {
    await client.query(lines.join("\n"));

    const text = [
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns",
      "WHERE table_schema = 'public' AND table_name = 'orbit_migration'",
      "ORDER BY ordinal_position",
    ].join("\n");

    const result = await client.query(text);

    const expected = [
      ["id", "text", "NO"],
      ["hash", "text", "NO"],
      ["time", "timestamp with time zone", "NO"],
    ];

    const actual = result.rows.map((row) => Object.values(row));
    const valid = JSON.stringify(actual) === JSON.stringify(expected);

    if (!valid) {
      throw new Error("MIGRATION_HISTORY: Invalid history structure.");
    }

    const constraint = [
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint",
      "WHERE conrelid = 'public.orbit_migration'::regclass AND contype = 'p'",
    ].join("\n");

    const constraints = await client.query(constraint);
    const unique = constraints.rows.length === 1;

    let primary = false;

    if (unique) {
      primary = constraints.rows[0].definition === "PRIMARY KEY (id)";
    }

    const checked = unique && primary;

    if (!checked) {
      throw new Error("MIGRATION_HISTORY: Invalid history key.");
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        "MIGRATION_ROLLBACK: Rollback failed.",
        { cause: failure },
      );
    }

    throw error;
  }
}

async function history(client, entries) {
  const stored = await client.query(
    "SELECT id, hash, time FROM public.orbit_migration ORDER BY id",
  );

  if (stored.rows.length > entries.length) {
    throw new Error("MIGRATION_HISTORY: Unknown migration history.");
  }

  for (let index = 0; index < stored.rows.length; index++) {
    const row = stored.rows[index];
    const entry = entries[index];
    const id = row.id === entry.id;
    const hash = row.hash === entry.hash;
    const date = row.time instanceof Date;

    let time = false;

    if (date) {
      time = Number.isFinite(row.time.getTime());
    }

    const valid = id && hash && time;

    if (!valid) {
      throw new Error("MIGRATION_HISTORY: History or checksum mismatch.");
    }
  }

  return stored.rows.length;
}

async function apply(client, entry) {
  await client.query("BEGIN");

  try {
    for (const text of entry.commands) {
      await client.query(text);
    }

    const values = [entry.id, entry.hash];

    await client.query(
      "INSERT INTO public.orbit_migration (id, hash) VALUES ($1, $2)",
      values,
    );

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        "MIGRATION_ROLLBACK: Rollback failed.",
        { cause: failure },
      );
    }

    throw new Error(`MIGRATION_APPLY: ${entry.id} failed.`, { cause: error });
  }
}

export async function run(settings, option = {}) {
  const string = typeof option.directory === "string";

  let absolute = false;

  if (string) {
    absolute = path.isAbsolute(option.directory);
  }

  const directory = string && absolute;

  if (!directory) {
    throw new Error("MIGRATION_FILE: Use an absolute migration directory.");
  }

  const timeout = option.timeout ?? 5000;
  const integer = Number.isInteger(timeout);
  const minimum = timeout > 0;
  const maximum = timeout <= 60000;
  const valid = integer && minimum && maximum;

  if (!valid) {
    throw new Error("MIGRATION_LOCK: Invalid timeout.");
  }

  const client = await connection.open(settings);

  let held = false;

  try {
    const primary = await client.query(
      "SELECT pg_is_in_recovery() AS replica, current_setting('transaction_read_only') AS readonly",
    );

    const row = primary.rows[0];

    let value = row.replica;

    if (!value) {
      value = row.readonly !== "off";
    }

    if (value) {
      throw new Error("MIGRATION_PRIMARY: Writable primary required.");
    }

    await lock(client, timeout);

    held = true;

    const entries = await files(option.directory);

    await prepare(client);

    const before = await history(client, entries);

    for (const entry of entries.slice(before)) {
      await apply(client, entry);
    }

    const after = await history(client, entries);

    if (after !== entries.length) {
      throw new Error("MIGRATION_HISTORY: Incomplete migration history.");
    }

    const applied = after - before;
    const answer = { applied, total: after };

    return answer;
  } finally {
    try {
      if (held) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", key);
      }
    } finally {
      await client.close();
    }
  }
}

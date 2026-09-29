import * as fs from "node:fs/promises";
import * as stream from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import process from "node:process";
import * as connection from "#db/core/connection.js";
import * as command from "#db/core/command.js";

const pattern = /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/u;
const key = [1330790985, 2];

function digest(text) {
  const result = crypto.createHash("sha256").update(text).digest("hex");

  return result;
}

async function checksum(filename) {
  const hash = crypto.createHash("sha256");

  for await (const buffer of stream.createReadStream(filename)) {
    hash.update(buffer);
  }

  return hash.digest("hex");
}

async function regular(filename, folder = false) {
  const details = await fs.lstat(filename);

  let type;

  if (folder) {
    type = details.isDirectory();
  } else {
    type = details.isFile();
  }

  const owner = details.uid === process.getuid?.();
  const link = details.isSymbolicLink();
  const writable = details.mode & 0o022;
  const unlinked = !link;
  const secure = !writable;
  const safe = unlinked && secure;
  const valid = type && owner && safe;

  if (!valid) {
    throw new Error("BACKUP_OWNER: Unmanaged backup path.");
  }

  let output = !folder;

  if (output) {
    output = details.nlink !== 1;
  }

  if (output) {
    throw new Error("BACKUP_OWNER: Shared backup file.");
  }

  return details;
}

async function sync(filename) {
  const handle = await fs.open(filename, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function write(filename, value) {
  const text = JSON.stringify(value) + "\n";
  const option = { flag: "wx", mode: 0o600 };

  await fs.writeFile(filename, text, option);

  await sync(filename);
}

async function registry(directory) {
  await regular(directory, true);

  const real = await fs.realpath(directory);

  if (real !== directory) {
    throw new Error("BACKUP_OWNER: Use the managed backup directory.");
  }

  const filename = path.join(directory, ".orbit.json");

  let catalog;

  try {
    await regular(filename);

    catalog = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("BACKUP_OWNER: Invalid backup registry.", {
        cause: error,
      });
    }

    catalog = { project: "Orbit", version: 1, entries: [] };
  }

  const project = catalog.project === "Orbit";
  const version = catalog.version === 1;
  const entries = Array.isArray(catalog.entries);
  const valid = project && version && entries;

  if (!valid) {
    throw new Error("BACKUP_OWNER: Invalid backup registry.");
  }

  const seen = new Set();

  for (const entry of catalog.entries) {
    const name = typeof entry.id === "string";

    let named = false;

    if (name) {
      named = pattern.test(entry.id);
    }

    const hash = typeof entry.hash === "string";

    let matched = false;

    if (hash) {
      matched = /^[a-f0-9]{64}$/u.test(entry.hash);
    }

    const unique = !seen.has(entry.id);
    const valid = named && matched && unique;

    if (!valid) {
      throw new Error("BACKUP_OWNER: Invalid backup registry entry.");
    }

    seen.add(entry.id);
  }

  return catalog;
}

async function save(directory, value) {
  const filename = path.join(directory, ".orbit.json");
  const token = crypto.randomUUID();
  const temporary = path.join(directory, `.registry-${token}.tmp`);

  try {
    await write(temporary, value);

    await fs.rename(temporary, filename);

    await sync(directory);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function tools(option) {
  for (const name of ["pg_dump", "pg_restore"]) {
    const executable = path.join(option.tools, name);
    const report = await command.run(executable, ["--version"], option);

    if (!/\(PostgreSQL\) 18\./u.test(report)) {
      throw new Error("BACKUP_VERSION: PostgreSQL 18 tools required.");
    }
  }
}

function environment(settings, option) {
  const env = {
    PGHOST: settings.host,
    PGPORT: String(settings.port),
    PGDATABASE: settings.database,
    PGUSER: settings.user,
    PGPASSWORD: settings.password,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: option.ca,
    PGCONNECT_TIMEOUT: "5",
    PGAPPNAME: "orbit-backup",
  };

  return env;
}

async function administrator(settings, option) {
  if (settings.database !== "orbit") {
    throw new Error("BACKUP_TARGET: Only the Orbit database is allowed.");
  }

  await regular(option.administrator);

  const text = await fs.readFile(option.administrator, "utf8");
  const user = text.match(/^PGUSER=(.+)$/m)?.[1];
  const password = text.match(/^PGPASSWORD=(.+)$/m)?.[1];
  const valid = user === "orbitadmin";
  const present = Boolean(password);
  const credentials = valid && present;

  if (!credentials) {
    throw new Error(
      "BACKUP_CONFIG: Orbit administrator configuration required.",
    );
  }

  const config = { ...settings, database: "postgres", user, password };
  const client = await connection.open(config);

  try {
    const sql = [
      "SELECT system_identifier::text AS cluster,",
      "current_setting('server_version_num')::integer AS version,",
      "pg_is_in_recovery() AS recovery,",
      "current_setting('transaction_read_only') AS readonly",
      "FROM pg_control_system()",
    ].join("\n");

    const result = await client.query(sql);
    const row = result.rows[0];
    const cluster = row.cluster === option.cluster;
    const minimum = row.version >= 180000;
    const maximum = row.version < 190000;
    const primary = !row.recovery;
    const writable = row.readonly === "off";
    const valid = cluster && minimum && maximum && primary && writable;

    if (!valid) {
      throw new Error("BACKUP_TARGET: Orbit PostgreSQL 18 cluster required.");
    }

    const held = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS held",
      key,
    );

    if (!held.rows[0].held) {
      throw new Error("BACKUP_LOCK: Backup operation already running.");
    }

    return client;
  } catch (error) {
    await client.close();

    throw error;
  }
}

async function release(client) {
  try {
    await client.query("SELECT pg_advisory_unlock($1, $2)", key);
  } finally {
    await client.close();
  }
}

async function state(client) {
  const table = await client.query(
    "SELECT to_regclass('public.orbit_migration') AS name",
  );

  if (!table.rows[0].name) {
    throw new Error("BACKUP_HISTORY: Migration history required.");
  }

  const history = await client.query(
    "SELECT id, hash, time FROM public.orbit_migration ORDER BY id",
  );

  const sql = [
    "SELECT table_schema, table_name, column_name, data_type,",
    "is_nullable, column_default FROM information_schema.columns",
    "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
    "ORDER BY table_schema, table_name, ordinal_position",
  ].join("\n");

  const schema = await client.query(sql);
  const records = JSON.stringify(history.rows);
  const columns = JSON.stringify(schema.rows);
  const result = { history: digest(records), schema: digest(columns) };

  return result;
}

async function archive(filename, option) {
  const executable = path.join(option.tools, "pg_restore");
  const args = ["--file=/dev/null", filename];

  await command.run(executable, args, option);
}

async function inspect(entry, settings, option) {
  const directory = path.join(option.directory, entry.id);

  await regular(directory, true);

  const names = (await fs.readdir(directory)).sort();

  if (names.join(",") !== "data.dump,meta.json") {
    throw new Error("BACKUP_OWNER: Unexpected backup files.");
  }

  const filename = path.join(directory, "data.dump");
  const metadata = path.join(directory, "meta.json");

  await regular(metadata);

  const text = await fs.readFile(metadata, "utf8");

  if (digest(text) !== entry.hash) {
    throw new Error("BACKUP_INTEGRITY: Metadata checksum mismatch.");
  }

  const descriptor = JSON.parse(text);
  const project = descriptor.project === "Orbit";
  const version = descriptor.version === 1;
  const database = descriptor.database === settings.database;
  const cluster = descriptor.cluster === option.cluster;
  const format = descriptor.format === "custom";
  const time = Number.isFinite(Date.parse(descriptor.time));
  const valid = project && version && database && cluster && format && time;

  if (!valid) {
    throw new Error("BACKUP_INTEGRITY: Invalid backup metadata.");
  }

  const details = await regular(filename);
  const hash = await checksum(filename);
  const size = details.size === descriptor.size;
  const same = hash === descriptor.hash;
  const complete = size && same;

  if (!complete) {
    throw new Error("BACKUP_INTEGRITY: Archive checksum mismatch.");
  }

  await archive(filename, option);

  const result = { entry, directory, filename, metadata: descriptor };

  return result;
}

async function prune(settings, option, records) {
  const retention = option.retention ?? null;

  if (retention === null) {
    const result = { removed: [], damaged: [] };

    return result;
  }

  const integer = Number.isInteger(retention);
  const positive = retention > 0;
  const valid = integer && positive;

  if (!valid) {
    throw new Error("BACKUP_CONFIG: Invalid retention period.");
  }

  const normal = [];
  const damaged = [];

  for (const entry of records.entries) {
    try {
      normal.push(await inspect(entry, settings, option));
    } catch {
      damaged.push(entry.id);
    }
  }

  normal.sort((left, right) => {
    const newer = Date.parse(right.metadata.time);
    const older = Date.parse(left.metadata.time);
    const result = newer - older;

    return result;
  });

  const latest = normal[0]?.entry.id;
  const cutoff = Date.now() - retention * 86400000;
  const removed = [];

  for (const backup of normal) {
    if (backup.entry.id === latest) {
      continue;
    }

    if (Date.parse(backup.metadata.time) >= cutoff) {
      continue;
    }

    await inspect(backup.entry, settings, option);

    await fs.unlink(path.join(backup.directory, "data.dump"));

    await fs.unlink(path.join(backup.directory, "meta.json"));

    await fs.rmdir(backup.directory);

    records.entries = records.entries.filter((entry) => {
      return entry.id !== backup.entry.id;
    });

    await save(option.directory, records);

    removed.push(backup.entry.id);
  }

  const result = { removed, damaged };

  return result;
}

export async function create(settings, option) {
  await tools(option);

  const client = await administrator(settings, option);
  const token = crypto.randomUUID();
  const temporary = path.join(option.directory, `.pending-${token}`);

  let destination;
  let published = false;
  let snapshot;

  try {
    const records = await registry(option.directory);

    await fs.mkdir(temporary, { mode: 0o700 });

    const filename = path.join(temporary, "data.dump");
    const source = { ...settings, idle_in_transaction_session_timeout: 0 };

    snapshot = await connection.open(source);

    await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const observed = await state(snapshot);

    const report = await snapshot.query(
      "SELECT pg_export_snapshot() AS snapshot, current_setting('server_version') AS version",
    );

    const exported = report.rows[0];
    const time = new Date().toISOString();
    const executable = path.join(option.tools, "pg_dump");

    const args = [
      "--format=custom",
      "--no-password",
      "--file",
      filename,
      "--snapshot",
      exported.snapshot,
    ];

    const env = environment(settings, option);
    const execution = { ...option, env };

    await command.run(executable, args, execution);

    await snapshot.query("COMMIT");

    await fs.chmod(filename, 0o600);

    await sync(filename);

    await archive(filename, option);

    const details = await regular(filename);
    const hash = await checksum(filename);

    const descriptor = {
      project: "Orbit",
      version: 1,
      time,
      postgres: exported.version,
      database: env.PGDATABASE,
      format: "custom",
      size: details.size,
      hash,
      cluster: option.cluster,
      ...observed,
    };

    const metadata = path.join(temporary, "meta.json");

    await write(metadata, descriptor);

    await sync(temporary);

    const stamp = time.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
    const id = `${stamp}-${token}`;

    destination = path.join(option.directory, id);

    await fs.rename(temporary, destination);

    const text = await fs.readFile(path.join(destination, "meta.json"), "utf8");
    const signature = digest(text);

    records.entries.push({ id, hash: signature });

    await save(option.directory, records);

    published = true;

    const retention = await prune(settings, option, records);
    const result = { id, ...descriptor, retention };

    return result;
  } finally {
    try {
      try {
        if (snapshot) {
          await snapshot.close();
        }
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });

        let valid = destination;

        if (valid) {
          valid = !published;
        }

        if (valid) {
          await fs.rm(destination, { recursive: true, force: true });
        }
      }
    } finally {
      await release(client);
    }
  }
}

export async function verify(settings, option) {
  await tools(option);

  const client = await administrator(settings, option);

  try {
    const records = await registry(option.directory);

    const entry = records.entries.find((entry) => {
      return entry.id === option.id;
    });

    if (!entry) {
      throw new Error("BACKUP_OWNER: Unknown backup.");
    }

    const result = await inspect(entry, settings, option);

    return result.metadata;
  } finally {
    await release(client);
  }
}

export async function restore(settings, option) {
  await tools(option);

  const client = await administrator(settings, option);
  const token = crypto.randomBytes(12).toString("hex");
  const database = `orbit_restore_${token}`;

  let created = false;

  try {
    const records = await registry(option.directory);

    const entry = records.entries.find((entry) => {
      return entry.id === option.id;
    });

    if (!entry) {
      throw new Error("BACKUP_OWNER: Unknown backup.");
    }

    const backup = await inspect(entry, settings, option);

    await client.query(
      `CREATE DATABASE "${database}" OWNER orbit TEMPLATE template0`,
    );

    created = true;

    const target = { ...settings, database };
    const executable = path.join(option.tools, "pg_restore");

    const args = [
      "--no-password",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction",
      "--dbname",
      database,
      backup.filename,
    ];

    const env = environment(target, option);
    const execution = { ...option, env };

    await command.run(executable, args, execution);

    const restored = await connection.open(target);

    try {
      const observed = await state(restored);
      const schema = observed.schema === backup.metadata.schema;
      const history = observed.history === backup.metadata.history;
      const valid = schema && history;

      if (!valid) {
        throw new Error(
          "BACKUP_RESTORE: Schema or migration history mismatch.",
        );
      }
    } finally {
      await restored.close();
    }

    const result = { id: entry.id, restored: true };

    return result;
  } finally {
    try {
      if (created) {
        await client.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      }
    } finally {
      await release(client);
    }
  }
}

export async function clean(settings, option) {
  await tools(option);

  const client = await administrator(settings, option);

  try {
    const records = await registry(option.directory);

    return await prune(settings, option, records);
  } finally {
    await release(client);
  }
}

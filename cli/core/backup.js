import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as command from "#cli/core/process.js";
import * as data from "#cli/core/data.js";
import * as schedule from "#cli/core/schedule.js";
import * as primary from "#cli/core/primary.js";
import { parseEnv } from "node:util";

export const filename = path.child(path.home, "backup.json");

async function owned(filename, folder = false) {
  const details = await fs.lstat(filename);

  let type;

  if (folder) {
    type = store.folder(details);
  } else {
    type = details.isFile();
  }

  const root = details.uid === 0;

  let single;

  if (folder) {
    single = true;
  } else {
    single = details.nlink === 1;
  }

  const writable = details.mode & 0o022;
  const secure = !writable;
  const valid = type && root && single && secure;

  if (!valid) {
    throw new Error("BACKUP_OWNER: Unmanaged backup path.");
  }
}

export async function erasing(manifest) {
  if (!(await store.exists(path.backup))) {
    return;
  }

  await owned(path.backup, true);

  if (!store.entry(manifest, path.backup)) {
    throw new Error("BACKUP_OWNER: Unmanaged backup directory.");
  }

  const names = await fs.readdir(path.backup);

  if (names.length === 0) {
    return;
  }

  const filename = path.child(path.backup, ".orbit.json");

  await owned(filename);

  const registry = JSON.parse(await fs.readFile(filename, "utf8"));
  const project = registry.project === "Orbit";
  const version = registry.version === 1;
  const entries = Array.isArray(registry.entries);
  const valid = project && version && entries;

  if (!valid) {
    throw new Error("BACKUP_OWNER: Invalid backup registry.");
  }

  const allowed = new Set([".orbit.json"]);

  for (const entry of registry.entries) {
    const name = /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/u.test(entry.id);
    const unique = !allowed.has(entry.id);
    const valid = name && unique;

    if (!valid) {
      throw new Error("BACKUP_OWNER: Invalid backup identifier.");
    }

    const directory = path.child(path.backup, entry.id);

    await owned(directory, true);

    const files = (await fs.readdir(directory)).sort();

    if (files.join(",") !== "data.dump,meta.json") {
      throw new Error("BACKUP_OWNER: Unmanaged backup files.");
    }

    const metadata = path.child(directory, "meta.json");

    await owned(metadata);

    await owned(path.child(directory, "data.dump"));

    const hash = await store.digest(metadata);

    if (hash !== entry.hash) {
      throw new Error("BACKUP_OWNER: Backup metadata changed.");
    }

    allowed.add(entry.id);
  }

  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error("BACKUP_OWNER: Unmanaged or unfinished backup remains.");
    }
  }
}

export async function prepare(manifest) {
  command.root();

  await primary.guard("backup");

  const database = manifest.services.some((entry) => {
    const db = entry.role === "DB";
    const primary = entry.mode !== "replica";
    const target = db && primary;

    return target;
  });

  if (!database) {
    throw new Error("BACKUP_TARGET: Orbit database installation required.");
  }

  if (!(await store.exists(path.backup))) {
    const option = { data: true, keep: true, mode: 0o700 };

    await store.directory(manifest, path.backup, option);
  }

  const details = await fs.lstat(path.backup);
  const directory = store.folder(details);
  const owner = details.uid === 0;
  const writable = details.mode & 0o022;
  const secure = !writable;
  const valid = directory && owner && secure;

  let output = !valid;

  if (!output) {
    output = !store.entry(manifest, path.backup);
  }

  if (output) {
    throw new Error("BACKUP_OWNER: Managed backup directory required.");
  }

  if (!(await store.exists(filename))) {
    const policy = { enabled: false, interval: null, retention: null };
    const contents = JSON.stringify(policy) + "\n";
    const option = { mode: 0o600 };

    await store.file(manifest, filename, contents, option);
  }

  const entry = store.entry(manifest, filename);
  const hash = await store.digest(filename);

  let report = !entry;

  if (!report) {
    report = entry.hash !== hash;
  }

  if (report) {
    throw new Error(
      "BACKUP_CONFIG: Backup configuration changed outside Orbit.",
    );
  }

  const policy = JSON.parse(await fs.readFile(filename, "utf8"));

  validate(policy);

  return policy;
}

function validate(policy) {
  const enabled = typeof policy.enabled === "boolean";
  const interval = policy.interval;
  const retention = policy.retention;

  if (!enabled) {
    throw new Error("BACKUP_CONFIG: Invalid schedule setting.");
  }

  if (interval !== null) {
    const integer = Number.isInteger(interval);
    const minimum = interval >= 60;
    const maximum = interval <= 31536000;
    const valid = integer && minimum && maximum;

    if (!valid) {
      throw new Error("BACKUP_CONFIG: Invalid schedule interval.");
    }
  }

  if (retention !== null) {
    const integer = Number.isInteger(retention);
    const minimum = retention >= 1;
    const maximum = retention <= 36500;
    const valid = integer && minimum && maximum;

    if (!valid) {
      throw new Error("BACKUP_CONFIG: Invalid retention period.");
    }
  }

  let output = policy.enabled;

  if (output) {
    output = interval === null;
  }

  if (output) {
    throw new Error("BACKUP_CONFIG: Schedule interval required.");
  }
}

export async function configure(manifest, policy) {
  validate(policy);

  const previous = await prepare(manifest);
  const token = crypto.randomUUID();
  const temporary = path.adjacent(filename, `.backup-${token}.tmp`);
  const contents = JSON.stringify(policy) + "\n";

  try {
    const option = { flag: "wx", mode: 0o600 };

    await fs.writeFile(temporary, contents, option);

    await fs.rename(temporary, filename);

    store.entry(manifest, filename).hash = await store.digest(filename);

    await store.write(manifest);

    await schedule.set(manifest, policy);
  } catch (error) {
    await fs.writeFile(filename, JSON.stringify(previous) + "\n", {
      mode: 0o600,
    });

    store.entry(manifest, filename).hash = await store.digest(filename);

    await store.write(manifest);

    try {
      await schedule.set(manifest, previous);
    } catch (recovery) {
      throw new AggregateError(
        [error, recovery],
        "BACKUP_CONFIG: Schedule recovery failed.",
        { cause: recovery },
      );
    }

    throw error;
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export async function run(manifest, operation, id) {
  const policy = await prepare(manifest);
  const meta = await data.metadata();

  if (!meta?.cluster) {
    throw new Error("BACKUP_TARGET: Orbit cluster metadata required.");
  }

  const token = crypto.randomUUID();
  const temporary = path.temporary(`backup-${token}.json`);

  const settings = {
    directory: path.backup,
    tools: manifest.tools.postgres,
    administrator: path.administrator,
    cluster: meta.cluster,
    retention: policy.retention,
  };

  try {
    const contents = JSON.stringify(settings) + "\n";
    const option = { flag: "wx", mode: 0o600 };

    await fs.writeFile(temporary, contents, option);

    const entry = path.file("db", "backup.js");
    const args = [entry, operation];

    if (id) {
      args.push(id);
    }

    const variables = parseEnv(await fs.readFile(path.database, "utf8"));

    const env = {
      ...variables,
      DB_CONFIG: path.database,
      DB_BACKUP_CONFIG: temporary,
      NODE_ENV: "production",
    };

    const execution = { env, timeout: 360000, allow: true };
    const report = await command.run(manifest.tools.node, args, execution);

    if (report.code !== 0) {
      const diagnostic = report.diagnostic.trim();
      const recognized = /^BACKUP_[A-Z]+: [^\r\n]+$/u.test(diagnostic);

      let message;

      if (recognized) {
        message = diagnostic;
      } else {
        message = "BACKUP_FAILED: Operation failed.";
      }

      throw new Error(message);
    }

    return JSON.parse(report.output);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

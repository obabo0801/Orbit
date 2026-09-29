import * as platform from "#cli/core/platform.js";
import * as path from "#cli/core/path.js";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import { error } from "#cli/core/error.js";

export const directories = path.data;

const filename = path.meta;

function identifier(value) {
  if (value === null) {
    return true;
  }

  let result = typeof value === "string";

  if (result) {
    result = /^\d{10,20}$/.test(value);
  }

  return result;
}

function same(details, entry) {
  for (const name of ["dev", "ino", "uid", "gid", "mode"]) {
    if (details[name] !== entry[name]) {
      return false;
    }
  }

  const valid = !details.isSymbolicLink();

  return valid;
}

function safe(details, device) {
  let unsafe = details.dev !== device;

  if (!unsafe) {
    unsafe = details.isSymbolicLink();
  }

  if (unsafe) {
    return false;
  }

  if (details.isDirectory()) {
    return true;
  }

  let result = details.isFile();

  if (result) {
    result = details.nlink === 1;
  }

  return result;
}

export function validate(meta) {
  if (!meta) {
    throw error("data");
  }

  const fields = Object.keys(meta).sort().join(",");

  if (fields !== "cluster,project,version") {
    throw error("data");
  }

  const project = meta.project === "Orbit";
  const version = meta.version === 1;
  const cluster = identifier(meta.cluster);
  const valid = project && version && cluster;

  if (!valid) {
    throw error("data");
  }

  return meta;
}

export async function metadata() {
  await store.safe(filename);

  const details = await store.exists(filename);

  if (!details) {
    return null;
  }

  if (!store.secure(details)) {
    throw error("data");
  }

  const result = validate(JSON.parse(await fs.readFile(filename, "utf8")));

  return result;
}

export async function cluster(binary) {
  await store.safe(path.db);

  const details = await store.exists(path.db);

  if (!store.folder(details)) {
    throw error("data");
  }

  const text = await fs.readFile(path.version, "utf8");
  const version = text.trim();
  const program = path.child(binary, "pg_controldata");
  const env = { LC_ALL: "C" };
  const settings = { env };
  const tool = await command.run(program, ["--version"], settings);

  let invalid = !/^\d+$/.test(version);

  if (!invalid) {
    invalid = !tool.output.includes(`) ${version}.`);
  }

  if (invalid) {
    throw error("data");
  }

  const result = await command.run(program, [path.db], settings);

  if (result.diagnostic.trim()) {
    throw error("data");
  }

  const identifier = result.output.match(
    /^Database system identifier:\s+(\d+)$/m,
  )?.[1];

  const state = result.output.match(/^Database cluster state:\s+(.+)$/m)?.[1];

  let equal;

  if (identifier) {
    const primary = state === "shut down";
    const standby = state === "shut down in recovery";

    equal = primary || standby;
  }

  const clean = identifier && equal;

  let busy = !clean;

  if (!busy) {
    busy = await store.exists(path.pid);
  }

  if (busy) {
    throw error("running");
  }

  return identifier;
}

export async function stopped(manifest) {
  const processes = await platform.host.processes();

  if (
    processes.output.split("\n").some(function database(line) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      const postgres = /(?:^|[/\s])postgres(?:\s|$)/.test(line);
      const directory = line.includes(path.db);
      const within = pid !== process.pid;
      const value = within && postgres;
      const result = value && directory;

      return result;
    })
  ) {
    throw error("running");
  }

  const identity = manifest?.identities?.orbitdb;
  const options = { allow: true };
  const account = await command.run("/usr/bin/id", ["-u", "orbitdb"], options);

  if (account.code === 0) {
    let valid = identity;

    if (valid) {
      valid = Number(account.output.trim()) !== identity.uid;
    }

    if (valid) {
      throw error("changed");
    }

    const settings = { allow: true };

    const result = await command.run(
      "/usr/bin/pgrep",
      ["-u", "orbitdb"],
      settings,
    );

    if (result.code !== 1) {
      throw error("running");
    }
  }

  if (await store.exists(path.pid)) {
    throw error("running");
  }
}

async function scan(directory) {
  await store.safe(directory);

  const mounts = await platform.host.mounts();

  if (
    mounts.some(function mounted(mount) {
      let result = mount === directory;

      if (!result) {
        result = mount.startsWith(directory + "/");
      }

      return result;
    })
  ) {
    throw error("mount");
  }

  const base = await fs.lstat(directory);

  if (!store.folder(base)) {
    throw error("data");
  }

  const entries = [];

  async function visit(name) {
    const details = await fs.lstat(name);

    if (!safe(details, base.dev)) {
      throw error("data");
    }

    const { uid, gid, dev, ino, mode } = details;

    entries.push({ path: name, uid, gid, dev, ino, mode });

    if (details.isDirectory()) {
      for (const child of await fs.readdir(name)) {
        await visit(path.child(name, child));
      }
    }
  }

  await visit(directory);

  return entries;
}

export async function ownership(paths, option) {
  const { uid, gid, owners } = option;

  command.root();

  if (
    paths.some(function invalid(filename) {
      const valid = !directories.includes(filename);

      return valid;
    })
  ) {
    throw error("data");
  }

  const entries = [];

  for (const directory of paths) {
    entries.push(...(await scan(directory)));
  }

  let output = owners;

  if (output) {
    output = entries.some(function foreign(entry) {
      const valid = !owners.includes(entry.uid);

      return valid;
    });
  }

  if (output) {
    throw error("data");
  }

  for (const entry of entries) {
    const details = await fs.lstat(entry.path);

    if (!same(details, entry)) {
      throw error("data");
    }

    await fs.chown(entry.path, uid, gid);
  }
}

export async function preserve(manifest, option = {}) {
  command.root();

  const paths = [];

  for (const directory of directories) {
    if (await store.exists(directory)) {
      paths.push(directory);
    }
  }

  if (!paths.length) {
    return null;
  }

  await stopped(manifest);

  for (const directory of paths) {
    await scan(directory);
  }

  let identifier = null;

  if (paths.includes(path.db)) {
    const binary = option.binary ?? manifest.tools?.postgres;

    if (!binary?.startsWith("/")) {
      throw error("data");
    }

    identifier = await cluster(binary);
  }

  const previous = await metadata();

  if (previous) {
    if (previous.cluster !== identifier) {
      throw error("data");
    }
  }

  const meta = { project: "Orbit", version: 1, cluster: identifier };
  const token = randomUUID();
  const temporary = path.adjacent(filename, `.meta.${token}`);

  try {
    const handle = await fs.open(temporary, "wx", 0o600);

    try {
      await handle.writeFile(JSON.stringify(meta) + "\n");

      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(function absent(failure) {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }

  const directory = await fs.open(path.parent(filename), "r");

  try {
    await platform.host.sync(directory);
  } finally {
    await directory.close();
  }

  return meta;
}

export async function reuse(binary) {
  const meta = await metadata();

  if (!meta) {
    if (await store.exists(path.db)) {
      throw error("data");
    }

    return false;
  }

  if (meta.cluster !== null) {
    await stopped();

    if (meta.cluster !== (await cluster(binary))) {
      throw error("data");
    }
  } else if (await store.exists(path.db)) {
    throw error("data");
  }

  return meta.cluster !== null;
}

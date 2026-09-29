import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";

export const roots = path.roots;

const units = [
  "orbit-caddy.service",
  "orbit-was.service",
  "orbit-db.service",
  "orbit-monitor.service",
  "orbit-backup.service",
  "orbit-backup.timer",
];

export function entry(record, filename) {
  const result = record?.entries.find(function matches(entry) {
    return entry.path === filename;
  });

  return result;
}

export async function marker(record) {
  const filename = path.meta;
  const hash = await digest(filename);
  const entry = { path: filename, type: "file", keep: true, done: true, hash };

  record.entries.push(entry);
}

export function folder(details) {
  let result = details?.isDirectory();

  if (result) {
    result = !details.isSymbolicLink();
  }

  return result;
}

export function allowed(filename) {
  if (process.platform === "darwin") {
    const directory = filename === "/Library/PrivilegedHelperTools";

    const launcher =
      filename === "/Library/PrivilegedHelperTools/com.orbit.update";

    const policy = filename === "/private/etc/sudoers.d/orbit-update";
    const privileged = directory || launcher || policy;

    if (privileged) {
      return true;
    }
  }

  const directory = roots.some(function contains(directory) {
    let result = filename === directory;

    if (!result) {
      result = filename.startsWith(directory + "/");
    }

    return result;
  });

  if (directory) {
    return true;
  }

  const fenced = path.unit("orbit-db.service") + ".d";
  const folder = filename === fenced;
  const config = filename === path.child(fenced, "20-orbit-fence.conf");
  const managed = folder || config;

  if (managed) {
    return true;
  }

  const output = units.some(function matches(name) {
    let result = filename === path.unit(name);

    if (!result) {
      result = filename === path.startup(name);
    }

    return result;
  });

  return output;
}

export function secure(details) {
  const regular = details.isFile();
  const owned = details.uid === 0;
  const writable = details.mode & 0o022;

  let result = regular && owned;

  if (result) {
    result = !writable;
  }

  return result;
}

function canonical(filename) {
  let output = path.normalized(filename) !== filename;

  if (!output) {
    output = !allowed(filename);
  }

  if (output) {
    return false;
  }

  let traversal = filename.includes("/../");

  if (!traversal) {
    traversal = filename.includes("/./");
  }

  const valid = !traversal;

  return valid;
}

function header(record) {
  if (record.version !== 1) {
    return false;
  }

  const entries = Array.isArray(record.entries);
  const accounts = Array.isArray(record.accounts);
  const services = Array.isArray(record.services);
  const installed = typeof record.installed === "boolean";
  const result = entries && accounts && services && installed;

  return result;
}

export async function safe(filename, option = {}) {
  if (!canonical(filename)) {
    throw error("manifest");
  }

  let parent = path.parent(filename);

  const seen = option.seen ?? new Set();

  while (parent !== "/") {
    if (seen.has(parent)) {
      break;
    }

    const details = await fs.lstat(parent).catch(function absent(failure) {
      if (failure.code === "ENOENT") {
        return null;
      }

      throw failure;
    });

    if (details?.isSymbolicLink()) {
      throw error("manifest");
    }

    seen.add(parent);

    parent = path.parent(parent);
  }
}

export async function exists(filename) {
  try {
    return await fs.lstat(filename);
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  }
}

export async function digest(filename) {
  const hash = crypto.createHash("sha256");
  const contents = await fs.readFile(filename);

  hash.update(contents);

  return hash.digest("hex");
}

export async function read() {
  const filename = path.path().installation;

  await safe(filename);

  const details = await exists(filename);

  if (!details) {
    return null;
  }

  if (!secure(details)) {
    throw error("manifest");
  }

  const record = JSON.parse(await fs.readFile(filename, "utf8"));

  if (!header(record)) {
    throw error("manifest");
  }

  const seen = new Set();
  const setting = { seen };

  for (const entry of record.entries) {
    let output = !allowed(entry.path);

    if (!output) {
      output = ![
        "file",
        "directory",
        "link",
        "data",
        "runtime",
        "log",
      ].includes(entry.type);
    }

    if (output) {
      throw error("manifest");
    }

    await safe(entry.path, setting);
  }

  if (
    record.accounts.some(function invalid(account) {
      const valid = !["orbitdb", "orbitwas", "orbitcaddy"].includes(account);

      return valid;
    })
  ) {
    throw error("manifest");
  }

  return record;
}

export async function write(record) {
  const filename = path.path().installation;

  await safe(filename);

  const token = crypto.randomUUID();
  const temporary = path.adjacent(filename, `.installation.${token}`);
  const contents = JSON.stringify(record, null, 2) + "\n";
  const file = await fs.open(temporary, "wx", 0o600);

  try {
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }

    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch((failure) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function directory(record, filename, options = {}) {
  await safe(filename);

  if (await exists(filename)) {
    throw error("collision");
  }

  let type;

  if (options.data) {
    type = "data";
  } else {
    type = "directory";
  }

  const keep = Boolean(options.keep);
  const mode = options.mode ?? 0o755;
  const entry = { path: filename, type, keep, done: false, mode };

  record.entries.push(entry);

  await write(record);

  const settings = { mode };

  await fs.mkdir(filename, settings);

  entry.done = true;

  await write(record);
}

export async function file(record, filename, text, options = {}) {
  await safe(filename);

  if (await exists(filename)) {
    throw error("collision");
  }

  const keep = Boolean(options.keep);
  const mode = options.mode ?? 0o644;
  const entry = { path: filename, type: "file", keep, done: false, mode };

  record.entries.push(entry);

  await write(record);

  const settings = { flag: "wx", mode };

  await fs.writeFile(filename, text, settings);

  entry.hash = await digest(filename);
  entry.done = true;

  await write(record);
}

export async function inventory(record, directory) {
  const entries = new Map(
    record.entries.map(function pair(entry) {
      const result = [entry.path, entry];

      return result;
    }),
  );

  async function visit(filename) {
    const details = await fs.lstat(filename);

    if (!entries.has(filename)) {
      let type = "file";

      if (details.isSymbolicLink()) {
        type = "link";
      } else if (details.isDirectory()) {
        type = "directory";
      }

      const entry = { path: filename, type, done: true, keep: false };

      if (entry.type === "file") {
        entry.hash = await digest(filename);
      }

      if (entry.type === "link") {
        entry.target = await fs.readlink(filename);
      }

      record.entries.push(entry);
    }

    let valid = details.isDirectory();

    if (valid) {
      valid = !details.isSymbolicLink();
    }

    if (valid) {
      for (const name of await fs.readdir(filename)) {
        await visit(path.child(filename, name));
      }
    }
  }

  await visit(directory);

  await write(record);
}

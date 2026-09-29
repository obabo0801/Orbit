import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import { error } from "#cli/core/error.js";

export async function environment() {
  await command.run("/bin/launchctl", ["print", "system"]);
}

export async function create(name) {
  const users = await command.run("/usr/bin/dscl", [
    ".",
    "-list",
    "/Users",
    "UniqueID",
  ]);

  const groups = await command.run("/usr/bin/dscl", [
    ".",
    "-list",
    "/Groups",
    "PrimaryGroupID",
  ]);

  const ids = new Set(
    (users.output + groups.output)
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/).at(-1))),
  );

  let id = 400;

  while (true) {
    let valid = ids.has(id);

    if (valid) {
      valid = id < 500;
    }

    if (!valid) {
      break;
    }

    id++;
  }

  if (id >= 500) {
    throw error("collision");
  }

  const gid = String(id);
  const user = "/Users/" + name;
  const group = "/Groups/" + name;

  const records = [
    [group, "PrimaryGroupID", gid],
    [user, "UniqueID", gid],
    [user, "PrimaryGroupID", gid],
    [user, "UserShell", "/usr/bin/false"],
    [user, "NFSHomeDirectory", "/var/empty"],
    [user, "IsHidden", "1"],
    [user, "Password", "*"],
  ];

  for (const fields of records) {
    const args = [".", "-create", ...fields];

    await command.run("/usr/bin/dscl", args);
  }
}

export async function group(name) {
  const args = [".", "-read", "/Groups/" + name, "PrimaryGroupID"];
  const report = await command.run("/usr/bin/dscl", args, { allow: true });

  let valid = report.code !== 0;

  if (valid) {
    valid = !/eDSRecordNotFound|DS Error: -14136/.test(
      report.output + report.diagnostic,
    );
  }

  if (valid) {
    throw error("system");
  }

  let result;

  if (report.code === 0) {
    result = Number(report.output.trim().split(/\s+/).at(-1));
  } else {
    result = null;
  }

  return result;
}

export async function remove(name) {
  const args = [".", "-delete", "/Users/" + name];
  const option = { timeout: 0 };

  await command.run("/usr/bin/dscl", args, option);
}

export async function ungroup(name) {
  const args = [".", "-delete", "/Groups/" + name];

  await command.run("/usr/bin/dscl", args);
}

export async function tools() {
  await fs.access("/usr/bin/dscl");

  await fs.access("/usr/bin/sudo");
}

export async function user(name, program, args, option = {}) {
  const values = ["-u", name, "--", program, ...args];

  return await command.run("/usr/bin/sudo", values, option);
}

export async function mounts() {
  const report = await command.run("/sbin/mount", []);

  const result = report.output.split("\n").flatMap((line) => {
    const match = line.match(/ on (.+) \(/);

    let values;

    if (match) {
      values = [match[1]];
    } else {
      values = [];
    }

    return values;
  });

  return result;
}

export async function sockets() {
  const args = ["-nP", "-iTCP", "-sTCP:LISTEN"];
  const result = await command.run("/usr/sbin/lsof", args, { allow: true });

  if (![0, 1].includes(result.code)) {
    throw error("system");
  }

  return result;
}

export async function processes() {
  const args = ["-axo", "pid=,command="];

  return await command.run("/bin/ps", args);
}

export const locale = "C";

export async function layout() {
  const root = path.parent(path.storage);

  await store.safe(path.storage);

  const details = await fs.lstat(root).catch((failure) => {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  });

  let valid = details;

  if (valid) {
    valid = !store.folder(details);
  }

  if (valid) {
    throw error("changed");
  }

  if (!details) {
    await fs.mkdir(root, { mode: 0o755 });
  }
}

export async function prepare(manifest, identities) {
  const details = await fs.lstat(path.root);

  if (details.uid !== 0) {
    throw error("changed");
  }

  if (!(await store.exists(path.log))) {
    await store.directory(manifest, path.log, { mode: 0o755 });
  }

  const text = crypto.randomUUID() + "\n";

  if (!(await store.exists(path.machine))) {
    await store.file(manifest, path.machine, text, { mode: 0o600 });
  } else if (!store.entry(manifest, path.machine)) {
    throw error("collision");
  }

  for (const [name, identity] of Object.entries(identities)) {
    const role = name.slice(5);
    const file = path.journal(role);

    if (await store.exists(file)) {
      if (!store.entry(manifest, file)) {
        throw error("collision");
      }

      continue;
    }

    await store.file(manifest, file, "", { mode: 0o600 });

    await fs.chown(file, identity.uid, identity.gid);

    const entry = store.entry(manifest, file);

    entry.type = "log";
    entry.uid = identity.uid;

    await store.write(manifest);
  }

  const monitor = path.journal("monitor");

  if (!(await store.exists(monitor))) {
    await store.file(manifest, monitor, "", { mode: 0o600 });

    const entry = store.entry(manifest, monitor);

    entry.type = "log";
    entry.uid = 0;

    await store.write(manifest);
  } else if (!store.entry(manifest, monitor)) {
    throw error("collision");
  }

  const directories = [
    [path.socket, identities.orbitdb],
    [path.caddy.runtime, identities.orbitcaddy],
  ];

  for (const [directory, identity] of directories) {
    if (identity) {
      if (await store.exists(directory)) {
        if (!store.entry(manifest, directory)) {
          throw error("collision");
        }

        continue;
      }

      await store.directory(manifest, directory, { mode: 0o750 });

      await fs.chown(directory, identity.uid, identity.gid);
    }
  }
}

export async function sync(directory) {
  try {
    await directory.sync();
  } catch (failure) {
    if (failure.code !== "EINVAL") {
      throw failure;
    }
  }
}

export async function finish() {
  await fs.rmdir(path.root).catch((failure) => {
    if (!["ENOENT", "ENOTEMPTY"].includes(failure.code)) {
      throw failure;
    }
  });
}

import * as fs from "node:fs/promises";
import * as postgres from "#cli/platform/mac/postgres.js";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import { error } from "#cli/core/error.js";
import { layout } from "#cli/platform/index.js";

const locations = layout("darwin").packages;
const formulas = { postgres: "postgresql@18", openssl: "openssl@3" };

export async function tailscale() {
  const directories = ["/Applications"];
  const user = process.env.SUDO_USER ?? process.env.USER;

  if (user) {
    if (/^[a-z_][a-z0-9_-]*$/i.test(user)) {
      directories.push(path.child("/Users/" + user, "Applications"));
    }
  }

  const candidates = [];

  for (const directory of directories) {
    let entries;

    try {
      entries = await fs.readdir(directory);
    } catch (failure) {
      if (!["ENOENT", "EACCES"].includes(failure.code)) {
        throw failure;
      }

      continue;
    }

    for (const entry of entries) {
      if (!/^tailscale.*\.app$/i.test(entry)) {
        continue;
      }

      const folder = path.child(directory, entry + "/Contents/MacOS");

      let programs;

      try {
        programs = await fs.readdir(folder);
      } catch (failure) {
        if (!["ENOENT", "EACCES"].includes(failure.code)) {
          throw failure;
        }

        continue;
      }

      for (const name of programs) {
        if (!/^tailscale$/i.test(name)) {
          continue;
        }

        const filename = path.child(folder, name);

        try {
          const details = await fs.stat(filename);

          if (!details.isFile()) {
            continue;
          }

          await fs.access(filename, fs.constants.X_OK);

          candidates.push(filename);
        } catch (failure) {
          if (!["ENOENT", "EACCES"].includes(failure.code)) {
            throw failure;
          }
        }
      }
    }
  }

  return candidates;
}

export async function publish(filename) {
  const details = await fs.lstat(filename);

  if (details.isSymbolicLink()) {
    await fs.lchown(filename, 0, 0);

    await fs.lchmod(filename, 0o755);

    return;
  }

  await fs.chown(filename, 0, 0);

  if (details.isDirectory()) {
    await fs.chmod(filename, 0o755);

    for (const name of await fs.readdir(filename)) {
      await publish(path.child(filename, name));
    }

    return;
  }

  if (!details.isFile()) {
    throw error("config");
  }

  const executable = Boolean(details.mode & 0o111);

  let mode;

  if (executable) {
    mode = 0o755;
  } else {
    mode = 0o644;
  }

  await fs.chmod(filename, mode);
}

export async function database() {
  const candidates = locations.map((prefix) =>
    path.child(prefix, "opt/postgresql@18/bin"),
  );

  candidates.push("/Library/PostgreSQL/18/bin");

  for (const directory of candidates) {
    const binary = path.child(directory, "postgres");

    try {
      await fs.access(binary, fs.constants.X_OK);

      return directory;
    } catch (failure) {
      if (!["ENOENT", "EACCES"].includes(failure.code)) {
        throw failure;
      }
    }
  }

  return null;
}

export async function prepare(name, prepared) {
  const formula = formulas[name];

  if (!formula) {
    throw error("dependencies", { reason: "executable", target: name });
  }

  const user = process.env.SUDO_USER;
  const absent = !user;
  const root = user === "root";
  const invalid = absent || root;

  if (invalid) {
    throw error("dependencies", {
      reason: "executable",
      target: "Homebrew: run start.sh as your login account",
    });
  }

  let brew;

  for (const prefix of locations) {
    const filename = path.child(prefix, "bin/brew");

    try {
      await fs.access(filename, fs.constants.X_OK);

      brew = filename;

      break;
    } catch (failure) {
      if (!["ENOENT", "EACCES"].includes(failure.code)) {
        throw failure;
      }
    }
  }

  if (!brew) {
    if (name === "postgres") {
      return postgres.prepare(prepared);
    }

    throw error("dependencies", { reason: "executable", target: name });
  }

  const prefix = path.parent(path.parent(brew));
  const folder = path.child(prefix, "opt/" + formula);

  const exists = await fs.stat(folder).then(
    () => true,
    () => false,
  );

  const args = [
    "-u",
    user,
    "-H",
    "--",
    brew,
    "install",
    "--skip-post-install",
    formula,
  ];

  const env = {
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
  };

  const settings = { env, timeout: 900000 };

  await command.run("/usr/bin/sudo", args, settings);

  let program;

  if (name === "postgres") {
    program = "bin";
  } else {
    program = "bin/openssl";
  }

  const value = path.child(folder, program);

  const item = {
    name,
    value,
    shared: true,
    created: !exists,
    manager: brew,
    formula,
  };

  prepared.push(item);

  return value;
}

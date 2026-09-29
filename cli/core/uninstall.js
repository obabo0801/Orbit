import * as platform from "#cli/core/platform.js";
import * as path from "#cli/core/path.js";
import * as fs from "node:fs/promises";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import * as system from "#cli/core/system.js";
import { lock } from "#cli/core/lock.js";
import { error } from "#cli/core/error.js";
import * as data from "#cli/core/data.js";
import * as provision from "#cli/core/tools.js";
import * as intent from "#cli/core/intent.js";
import * as windows from "#cli/platform/windows/startup.js";
import * as schedule from "#cli/core/schedule.js";
import * as backup from "#cli/core/backup.js";

function present(report) {
  if (report.LoadState !== "not-found") {
    return true;
  }

  const pid = Number(report.MainPID);
  const stopped = ["inactive", "failed"].includes(report.ActiveState);

  let result = pid > 0;

  if (!result) {
    result = !stopped;
  }

  return result;
}

function mismatch(manifest, name, field, value) {
  const identity = manifest.identities?.[name];

  if (!identity) {
    return identity;
  }

  return identity[field] !== value;
}

function keep(entry, all) {
  const root = entry.path === path.storage;
  const runtime = entry.type === "runtime";

  let data = !all;

  if (data) {
    data = entry.keep;
  }

  const result = root || runtime || data;

  return result;
}

async function original(entry, details) {
  if (entry.type === "log") {
    const names = ["db", "was", "caddy", "monitor", "backup"];
    const files = names.map(path.journal);
    const file = details.isFile();
    const single = details.nlink === 1;
    const owned = details.uid === entry.uid;
    const allowed = files.includes(entry.path);
    const valid = file && single && owned && allowed;

    return valid;
  }

  let output = !details.isFile();

  if (!output) {
    output = !entry.hash;
  }

  if (output) {
    return false;
  }

  if (path.generated(entry.path)) {
    return true;
  }

  const hash = await store.digest(entry.path);

  return hash === entry.hash;
}

function retained(manifest, entry, all, failure) {
  let valid = failure.code !== "ENOTEMPTY";

  if (!valid) {
    valid = all;
  }

  if (valid) {
    return false;
  }

  const value = manifest.entries.some(function child(item) {
    let result = item.keep;

    if (result) {
      result = item.path.startsWith(entry.path + "/");
    }

    return result;
  });

  return value;
}

async function tree(filename, device) {
  await store.safe(filename);

  const details = await fs.lstat(filename);

  if (details.dev !== device) {
    throw error("mount");
  }

  let valid = details.isDirectory();

  if (valid) {
    valid = !details.isSymbolicLink();
  }

  if (valid) {
    for (const name of await fs.readdir(filename)) {
      await tree(path.child(filename, name), device);
    }

    await fs.rmdir(filename);
  } else {
    await fs.unlink(filename);
  }
}

export async function preview() {
  command.root();

  const manifest = await store.read();

  let valid = !manifest;

  if (valid) {
    valid = !(await data.metadata());
  }

  if (valid) {
    const result = [];

    return result;
  }

  const paths = [];

  for (const directory of data.directories) {
    if (await store.exists(directory)) {
      paths.push(directory);
    }
  }

  if (await store.exists(path.meta)) {
    paths.push(path.meta);
  }

  return paths;
}

async function residual(manifest) {
  const remaining = [];

  if (await store.exists(path.runtime)) {
    for (const name of await fs.readdir(path.runtime)) {
      const filename = path.child(path.runtime, name);

      if (["service.lock", "dashboard.lock"].includes(name)) {
        try {
          const owner = JSON.parse(await fs.readFile(filename, "utf8"));

          if (owner.pid === process.pid) {
            continue;
          }
        } catch {
          remaining.push(`Runtime: ${filename}`);

          continue;
        }
      }

      remaining.push(`Runtime: ${filename}`);
    }
  }

  for (const service of manifest.services.filter(function managed(service) {
    return service.unit;
  })) {
    const report = await system.state(service);

    if (present(report)) {
      remaining.push(service.unit);
    }

    if (report.ControlGroup) {
      const filename = path.cgroup(report.ControlGroup);

      const contents = await fs
        .readFile(filename, "utf8")
        .catch(function absent(failure) {
          if (failure.code === "ENOENT") {
            return "";
          }

          throw failure;
        });

      if (contents.trim()) {
        remaining.push(`Process: ${service.unit}`);
      }
    }
  }

  const sockets = await platform.host.sockets();

  for (const service of manifest.services) {
    let valid = service.port;

    if (valid) {
      valid = sockets.output.split("\n").some(function port(line) {
        return new RegExp(`:${service.port}\\s`).test(line);
      });
    }

    if (valid) {
      remaining.push(`Port: ${service.port}`);
    }
  }

  const processes = await platform.host.processes();

  for (const line of processes.output.split("\n")) {
    const pid = Number(line.trim().split(/\s+/)[0]);

    let outcome = pid !== process.pid;

    if (outcome) {
      outcome = path.managed(line);
    }

    if (outcome) {
      remaining.push(`Process: ${pid}`);
    }
  }

  return remaining;
}

export function stages(all = false) {
  const names = ["stopping", "preserving", "files"];

  if (all) {
    names.push("erasing");
  }

  names.push("units", "inspection", "accounts", "record", "runtime");

  return names;
}

export async function uninstall(all = false, option = {}) {
  command.root();

  let valid = all;

  if (valid) {
    valid = !option.confirmed;
  }

  if (valid) {
    throw error("confirmation");
  }

  const prepared = [];
  const setting = { ...option, prepared };

  try {
    return await removing(all, setting);
  } catch (failure) {
    await option.progress?.({ state: "failed" });

    throw failure;
  } finally {
    await provision.cleanup(prepared);

    await fs.rmdir(path.runtime).catch((failure) => {
      if (!["ENOENT", "ENOTEMPTY"].includes(failure.code)) {
        throw failure;
      }
    });
  }
}

async function removing(all, option) {
  command.root();

  let manifest = await store.read();

  const absent = !manifest;

  let retained = absent && all;

  if (retained) {
    retained = await data.metadata();
  }

  if (retained) {
    let version = null;

    if (await store.exists(path.db)) {
      const text = await fs.readFile(path.version, "utf8");

      version = text.trim();
    }

    let answer = version;

    if (answer) {
      answer = !/^\d+$/.test(version);
    }

    if (answer) {
      throw error("data");
    }

    const prepared = option.prepared;

    let supplied;

    if (version) {
      supplied = path.binary(version);
    } else {
      supplied = undefined;
    }

    const setting = { supplied, prepared };

    let binary;

    if (version) {
      binary = await provision.resolve("postgres", setting);
    } else {
      binary = undefined;
    }

    if (binary) {
      await data.reuse(binary);
    }

    const tools = { postgres: binary };

    manifest = {
      version: 1,
      installed: false,
      services: [],
      accounts: [],
      identities: {},
      tools,
      stage: "removing",
      entries: [],
    };

    for (const directory of data.directories) {
      if (await store.exists(directory)) {
        const entry = { path: directory, type: "data", keep: true, done: true };

        manifest.entries.push(entry);
      }
    }

    await store.marker(manifest);
  }

  if (!manifest) {
    return "skipped";
  }

  if (all) {
    await backup.erasing(manifest);
  }

  for (const entry of manifest.entries) {
    let user = data.directories.includes(entry.path);

    if (user) {
      user = entry.type === "data";
    }

    const metadata = entry.path === path.meta;
    const retained = user || metadata;

    let existing;

    if (retained) {
      existing = Boolean(await store.exists(entry.path));
    }

    entry.keep = retained && existing;
  }

  for (const entry of manifest.entries) {
    let received = entry.type === "data";

    if (received) {
      received = ![
        path.db,
        path.caddy.data,
        path.upload,
        path.backup,
        path.store,
        path.monitoring,
        path.history,
      ].includes(entry.path);
    }

    if (received) {
      throw error("manifest");
    }
  }

  const release = await lock("service");
  const problems = [];
  const names = stages(all);
  const managed = manifest.services.filter((service) => service.unit);

  async function step(name, action) {
    await option.progress?.({ name, state: "running", stages: names });

    const result = await action();

    await option.progress?.({ name, state: "complete", stages: names });

    return result;
  }

  try {
    await step("stopping", async function stop() {
      await schedule.remove(manifest);

      for (const service of [...manifest.services]
        .reverse()
        .filter(function managed(service) {
          return service.unit;
        })) {
        if (await system.adapter().running(service)) {
          await system.adapter().stop(service);
        }
      }

      await system.startup(manifest, false);

      manifest.installed = false;
      manifest.stage = "removing";

      await store.write(manifest);

      for (const service of managed) {
        const report = await system.state(service);

        let valid = Number(report.MainPID) > 0;

        if (!valid) {
          valid = ["active", "activating", "deactivating"].includes(
            report.ActiveState,
          );
        }

        if (valid) {
          throw error("running");
        }
      }
    });

    await intent.clear();

    await windows.remove(manifest);

    await step("preserving", () => preservation(manifest, all, option));

    await step("files", () => remove(manifest, all, problems));

    if (all) {
      const setting = { erasing: true };

      await step("erasing", () => remove(manifest, all, problems, setting));
    }

    await step("units", async function reload() {
      await system.reload(managed);
    });

    await provision.cleanup(option.prepared);

    option.prepared.length = 0;

    const leftovers = await step("inspection", () => residual(manifest));

    problems.push(...leftovers);

    if (!problems.length) {
      await step("accounts", () => accounts(manifest, problems));
    }

    await step("record", async function finalize() {
      if (problems.length) {
        manifest.stage = "residual";
      } else {
        manifest.stage = "removed";
      }

      manifest.residual = problems;

      await store.write(manifest);

      if (!problems.length) {
        const contents = await fs.readdir(path.storage);

        if (
          contents.some(function other(name) {
            let preserved;

            if (!all) {
              preserved = ["db", "upload", "meta.json"];
            } else {
              preserved = [];
            }

            const valid = !["installation.json", ...preserved].includes(name);

            return valid;
          })
        ) {
          problems.push(`${path.storage}: unrecorded items preserved`);

          manifest.stage = "residual";
          manifest.residual = problems;

          await store.write(manifest);
        } else {
          await fs.unlink(path.installation);

          if ((await fs.readdir(path.storage)).length === 0) {
            await fs.rmdir(path.storage);
          }
        }
      }

      if (problems.length) {
        const diagnostic = problems.join("\n");
        const failure = error("residual");

        failure.diagnostic = diagnostic;

        throw failure;
      }
    });

    await step("runtime", async function cleanup() {
      await release();

      await fs.rmdir(path.runtime).catch(function active(failure) {
        if (!["ENOENT", "ENOTEMPTY"].includes(failure.code)) {
          throw failure;
        }
      });
    });

    await platform.host.finish();

    return "complete";
  } finally {
    await release();

    await fs.rmdir(path.runtime).catch(function active(failure) {
      if (!["ENOENT", "ENOTEMPTY"].includes(failure.code)) {
        throw failure;
      }
    });
  }
}

async function preservation(manifest, all, option) {
  const paths = [];

  for (const directory of data.directories) {
    if (await store.exists(directory)) {
      paths.push(directory);
    }
  }

  let response = !all;

  if (response) {
    response = paths.length;
  }

  if (response) {
    await data.stopped(manifest);

    let binary = manifest.tools?.postgres;

    if (paths.includes(path.db)) {
      let program;

      if (binary) {
        program = path.child(binary, "pg_controldata");
      } else {
        program = null;
      }

      let present;

      if (program) {
        present = await store.exists(program);
      } else {
        present = null;
      }

      if (!present) {
        const prepared = option.prepared;
        const setting = { prepared };

        binary = await provision.resolve("postgres", setting);
      }
    }

    const options = { binary };

    let valid = await data.preserve(manifest, options);

    if (valid) {
      valid = !store.entry(manifest, path.meta);
    }

    if (valid) {
      await store.marker(manifest);
    }

    manifest.stage = "ownership";

    await store.write(manifest);

    const owners = [0];

    for (const account of manifest.accounts) {
      const options = { allow: true };

      const identity = await command.run(
        "/usr/bin/id",
        ["-u", account],
        options,
      );

      if (identity.code === 0) {
        const uid = Number(identity.output.trim());

        if (mismatch(manifest, account, "uid", uid)) {
          throw error("changed");
        }

        owners.push(uid);
      }
    }

    const setting = { uid: 0, gid: 0, owners };

    await data.ownership(paths, setting);
  }
}

async function remove(manifest, all, problems, option = {}) {
  const erasing = option.erasing ?? false;

  for (const entry of [...manifest.entries].sort(function deep(left, right) {
    const result = right.path.split("/").length - left.path.split("/").length;

    return result;
  })) {
    let user = data.directories.includes(entry.path);

    if (!user) {
      user = entry.path === path.meta;
    }

    let valid = all;

    if (valid) {
      valid = user !== erasing;
    }

    if (valid) {
      continue;
    }

    if (keep(entry, all)) {
      continue;
    }

    try {
      await store.safe(entry.path);

      const details = await store.exists(entry.path);

      if (!details) {
        continue;
      }

      const generated = entry.path === path.caddy.runtime;
      const storage = entry.type === "data";
      const recursive = storage || generated;

      if (recursive) {
        if (entry.path === path.backup) {
          await backup.erasing(manifest);
        }

        if (!store.folder(details)) {
          throw error("changed");
        }

        const parent = await fs.lstat(path.parent(entry.path));

        await tree(entry.path, parent.dev);
      } else if (entry.type === "directory") {
        if (!store.folder(details)) {
          throw error("changed");
        }

        await fs.rmdir(entry.path);
      } else if (entry.type === "link") {
        let report = !details.isSymbolicLink();

        if (!report) {
          report = (await fs.readlink(entry.path)) !== entry.target;
        }

        if (report) {
          throw error("changed");
        }

        await fs.unlink(entry.path);
      } else {
        if (!(await original(entry, details))) {
          throw error("changed");
        }

        await fs.unlink(entry.path);
      }
    } catch (failure) {
      if (retained(manifest, entry, all, failure)) {
        continue;
      }

      problems.push(`${entry.path}: ${failure.code ?? "internal"}`);
    }
  }
}

async function accounts(manifest, problems) {
  for (const account of manifest.accounts) {
    const options = { allow: true };
    const identity = await command.run("/usr/bin/id", ["-u", account], options);

    let changed = identity.code === 0;

    if (changed) {
      changed = mismatch(
        manifest,
        account,
        "uid",
        Number(identity.output.trim()),
      );
    }

    if (changed) {
      problems.push(`Account changed: ${account}`);

      continue;
    }

    if (identity.code === 0) {
      const settings = { allow: true };

      const processes = await command.run(
        "/usr/bin/pgrep",
        ["-u", account],
        settings,
      );

      if (processes.code !== 1) {
        problems.push(`Account: ${account}`);

        continue;
      }

      await platform.host.remove(account);
    }

    const gid = await platform.host.group(account);

    if (gid !== null) {
      if (mismatch(manifest, account, "gid", gid)) {
        problems.push(`Group changed: ${account}`);

        continue;
      }

      await platform.host.ungroup(account);
    }

    manifest.accounts = manifest.accounts.filter(function other(name) {
      return name !== account;
    });

    await store.write(manifest);
  }
}

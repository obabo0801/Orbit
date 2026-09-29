import * as fs from "node:fs/promises";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as primary from "#cli/core/primary.js";
import * as source from "#cli/core/source.js";
import * as git from "#cli/core/git.js";
import * as service from "#cli/core/service.js";
import * as health from "#cli/core/health.js";
import * as command from "#cli/core/process.js";
import { lock } from "#cli/core/lock.js";

export const filename = path.child(path.home, "update.json");

const finished = ["complete", "cancelled"];

async function read() {
  try {
    const details = await fs.lstat(filename);

    git.check(
      store.secure(details),
      "OWNER",
      "Update journal has an invalid owner.",
    );

    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  }
}

async function save(record, value) {
  value.time = Date.now();

  await primary.write(record, filename, JSON.stringify(value, null, 2) + "\n");
}

function selection(record) {
  const services = record.services.filter((entry) => {
    return ["WAS", "WEB", "CADDY", "MONITOR"].includes(entry.role);
  });

  const result = { ...record, services };

  return result;
}

async function preserved(record) {
  const files = record.entries.filter((entry) => {
    const regular = entry.type === "file";
    const configuration = entry.path.startsWith(path.home + "/");
    const metadata = entry.path === path.meta;
    const known = configuration || metadata;
    const tracked = regular && known;
    const journal = entry.path === filename;
    const retained = !journal;
    const included = tracked && retained;

    return included;
  });

  const values = [];

  for (const file of files) {
    values.push([file.path, await store.digest(file.path)]);
  }

  return values;
}

async function intact(values) {
  for (const [filename, digest] of values) {
    git.check(
      (await store.digest(filename)) === digest,
      "CONFIG",
      "An operating configuration changed during Update.",
    );
  }
}

async function database(record) {
  const entries = record.services.filter((entry) => entry.role === "DB");

  if (!entries.length) {
    return null;
  }

  const reports = await health.health(record, { timeout: 3000 });
  const report = reports.find((entry) => entry.role === "DB");
  const value = report?.replication;

  git.check(
    report?.state === "ready",
    "DATABASE",
    "Database must be healthy before Update.",
  );

  git.check(
    value?.cluster,
    "DATABASE",
    "Database identity could not be verified.",
  );

  const result = {
    pid: report.pid,
    cluster: value.cluster,
    timeline: value.timeline,
    recovery: value.recovery,
  };

  return result;
}

async function environment(record, directory, name) {
  const origin = path.folder(name);
  const destination = path.child(directory, name);
  const exists = await store.exists(origin);
  const values = [];

  if (!exists) {
    return values;
  }

  for (const entry of await fs.readdir(origin)) {
    if (!entry.startsWith(".env")) {
      continue;
    }

    const original = path.child(origin, entry);
    const target = path.child(destination, entry);
    const details = await fs.lstat(original);

    git.check(
      details.isFile(),
      "ENV",
      "An environment file is not a regular file.",
    );

    await fs.copyFile(original, target, fs.constants.COPYFILE_EXCL);

    await fs.chmod(target, details.mode & 0o777);

    await fs.chown(target, details.uid, details.gid);

    values.push({
      name: entry,
      digest: await store.digest(original),
      owned: Boolean(store.entry(record, original)),
    });
  }

  return values;
}

async function changed(origin, destination, names) {
  for (const name of names) {
    const previous = path.child(origin, name);
    const latest = path.child(destination, name);

    if (!(await store.exists(previous))) {
      return true;
    }

    if ((await store.digest(previous)) !== (await store.digest(latest))) {
      return true;
    }
  }

  return false;
}

async function dependencies(record, directory, name, rebuilt, option = {}) {
  option.signal?.throwIfAborted();

  const origin = path.folder(name);
  const destination = path.child(directory, name);

  const manifest = JSON.parse(
    await fs.readFile(path.child(destination, "package.json"), "utf8"),
  );

  const latest = JSON.parse(
    await fs
      .readFile(path.child(origin, "package.json"), "utf8")
      .catch((failure) => {
        if (failure.code === "ENOENT") {
          return "{}";
        }

        throw failure;
      }),
  );

  const previous = latest.packageManager;
  const expected = manifest.packageManager;

  git.check(
    /^pnpm@\d+\.\d+\.\d+$/u.test(expected),
    "PNPM",
    "The target must declare an exact pnpm version.",
  );

  if (previous) {
    git.check(
      expected === previous,
      "PNPM",
      "A pnpm version change requires explicit tool preparation.",
    );
  }

  const version = await command.run(record.tools.pnpm, ["--version"], {
    cwd: destination,
    signal: option.signal,
  });

  git.check(
    "pnpm@" + version.output.trim() === expected,
    "PNPM",
    "Installed pnpm does not match the target policy.",
  );

  const metadata = await changed(origin, destination, [
    "package.json",
    "pnpm-lock.yaml",
  ]);

  const modules = path.child(origin, "node_modules");
  const available = Boolean(await store.exists(modules));
  const missing = !available;
  const refresh = metadata || missing;

  if (refresh) {
    const args = ["install", "--frozen-lockfile", "--store-dir", path.store];

    if (name !== "web") {
      args.push("--prod");
    }

    await command.run(record.tools.pnpm, args, {
      cwd: destination,
      timeout: 300000,
      signal: option.signal,
    });
  } else {
    await fs.cp(modules, path.child(destination, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  }

  let build = false;

  if (name === "web") {
    const output = path.child(origin, "dist");
    const present = Boolean(await store.exists(output));
    const altered = rebuilt || metadata;
    const absent = !present;
    const rebuild = altered || absent;

    build = rebuild;

    if (rebuild) {
      await command.run(record.tools.pnpm, ["build"], {
        cwd: destination,
        timeout: 180000,
        signal: option.signal,
      });
    } else {
      await fs.cp(output, path.child(destination, "dist"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }

    await fs.access(path.child(destination, "dist/index.html"));
  }

  return { dependencies: refresh, build };
}

async function archive(request, record, directory) {
  const temporary = await fs.mkdtemp(path.child(os.tmpdir(), "orbit-export-"));
  const file = path.child(temporary, "source.tar");

  try {
    const user = process.env.SUDO_USER;

    if (user) {
      const uid = await command.run("/usr/bin/id", ["-u", user]);
      const gid = await command.run("/usr/bin/id", ["-g", user]);

      await fs.chown(
        temporary,
        Number(uid.output.trim()),
        Number(gid.output.trim()),
      );
    }

    await git.archive(request.checkout, request.target, temporary, {
      installed: path.source,
    });

    await fs.chown(temporary, 0, 0);

    await fs.chown(file, 0, 0);

    await fs.chmod(file, 0o600);

    await command.run("/usr/bin/tar", ["-xf", file, "-C", directory], {
      timeout: 60000,
    });
  } finally {
    await fs.unlink(file).catch((failure) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });

    await fs.rmdir(temporary);
  }
}

async function prepare(request, record, option = {}) {
  option.signal?.throwIfAborted();

  const previous = await read();

  if (previous) {
    git.check(
      finished.includes(previous.state),
      "PENDING",
      "A prior Update requires recovery or cleanup first.",
    );
  }

  const inspection = await git.inspect(request.checkout, {
    target: request.target,
    installed: path.source,
  });

  git.guard(inspection);

  const original = await database(record);
  const configs = await preserved(record);

  option.signal?.throwIfAborted();

  const directory = path.child(path.source, ".update-" + request.id);

  const journal = {
    id: request.id,
    target: request.target,
    checkout: inspection.checkout,
    state: "preparing",
    previous: record.source?.commit ?? null,
    directory,
    database: original,
    configs,
    packages: [],
  };

  await save(record, journal);

  await store.directory(record, directory, { mode: 0o700 });

  const input = path.child(directory, "input");
  const output = path.child(directory, "next");
  const before = path.child(directory, "before");

  await store.directory(record, input, { mode: 0o700 });

  await store.directory(record, output, { mode: 0o700 });

  await store.directory(record, before, { mode: 0o700 });

  try {
    await archive(request, record, input);

    option.signal?.throwIfAborted();

    await store.inventory(record, input);

    for (const name of source.packages) {
      option.signal?.throwIfAborted();

      const origin = path.folder(name);
      const destination = path.child(output, name);
      const exists = Boolean(await store.exists(origin));

      let original = [];

      if (exists) {
        original = await source.verify(record, origin);
      }

      await source.copy(record, path.child(input, name), destination);

      const latest = await source.fingerprint(destination);
      const rebuilt = JSON.stringify(original) !== JSON.stringify(latest);
      const variables = await environment(record, output, name);

      let result;

      try {
        result = await dependencies(record, output, name, rebuilt, option);
      } finally {
        await store.inventory(record, destination);
      }

      journal.packages.push({ name, original, latest, variables, ...result });

      await save(record, journal);
    }

    await intact(configs);

    option.signal?.throwIfAborted();

    journal.state = "prepared";

    await save(record, journal);

    return {
      target: journal.target,
      state: journal.state,
      packages: journal.packages.map(({ name, dependencies, build }) => {
        const result = { name, dependencies, build };

        return result;
      }),
    };
  } catch (failure) {
    journal.state = "failed:preparation";
    journal.error = failure.code ?? "UPDATE_PREPARATION";

    await save(record, journal);

    throw failure;
  }
}

function relocate(record, origin, destination) {
  const prefix = origin + "/";

  for (const entry of record.entries) {
    if (entry.path === origin) {
      entry.path = destination;
    } else if (entry.path.startsWith(prefix)) {
      entry.path = destination + entry.path.slice(origin.length);
    }
  }
}

async function ready(record) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const reports = await health.health(record, { timeout: 2000 });

    const applications = reports.filter((entry) =>
      ["WAS", "WEB"].includes(entry.role),
    );

    const healthy = applications.every((entry) => entry.state === "ready");

    if (healthy) {
      return;
    }

    await delay(1000);
  }

  git.check(
    false,
    "HEALTH",
    "Updated WAS or WEB failed Health; the Node remains excluded.",
  );
}

async function apply(request, record, journal) {
  git.check(
    journal.state === "prepared",
    "STATE",
    "The Node has not finished preparation.",
  );

  await intact(journal.configs);

  for (const entry of journal.packages) {
    const origin = path.folder(entry.name);
    const exists = Boolean(await store.exists(origin));

    let latest;

    if (exists) {
      latest = await source.verify(record, origin);
    } else {
      latest = [];
    }

    git.check(
      JSON.stringify(latest) === JSON.stringify(entry.original),
      "CHANGED",
      "Installed Source changed after preparation.",
    );
  }

  const selected = selection(record);
  const option = { locked: true, monitor: true, upgrade: false };

  let installed = false;

  journal.state = "stopping";

  await save(record, journal);

  try {
    await service.execute("stop", selected, option);

    journal.state = "applying";

    await save(record, journal);

    for (const name of ["db", "was", "web", "cli"]) {
      const origin = path.folder(name);
      const previous = path.child(journal.directory, "before/" + name);
      const destination = path.child(journal.directory, "next/" + name);

      journal.package = name;

      await save(record, journal);

      if (await store.exists(origin)) {
        await fs.rename(origin, previous);

        relocate(record, origin, previous);

        await store.inventory(record, previous);
      }

      await fs.rename(destination, origin);

      relocate(record, destination, origin);

      const variables = journal.packages.find(
        (entry) => entry.name === name,
      ).variables;

      for (const variable of variables) {
        const filename = path.child(origin, variable.name);

        git.check(
          (await store.digest(filename)) === variable.digest,
          "ENV",
          "An environment file changed during Update.",
        );

        if (!variable.owned) {
          record.entries = record.entries.filter(
            (entry) => entry.path !== filename,
          );
        }
      }

      await store.write(record);
    }

    installed = true;
    record.source = {
      commit: journal.target,
      state: "verifying",
      updated: Date.now(),
    };
    journal.state = "verifying";

    await store.write(record);

    await save(record, journal);

    await service.execute("start", selected, option);

    await ready(selected);

    await intact(journal.configs);

    const latest = await database(record);

    git.check(
      JSON.stringify(latest) === JSON.stringify(journal.database),
      "DATABASE",
      "Database role, process, Cluster or Timeline changed.",
    );

    await source.remove(record, journal.directory);

    record.source.state = "complete";
    journal.state = "applied";

    await store.write(record);

    await save(record, journal);
  } catch (failure) {
    try {
      await service.execute("stop", selected, option);
    } catch (cleanup) {
      throw new AggregateError(
        [failure, cleanup],
        "UPDATE_STOP: Failed to exclude the failed Node.",
        { cause: cleanup },
      );
    } finally {
      const untouched = journal.state === "stopping";

      let commit = null;

      if (installed) {
        commit = journal.target;
      } else if (untouched) {
        commit = journal.previous;
      }

      journal.state = "failed:application";
      journal.error = failure.code ?? "UPDATE_APPLICATION";
      record.source = { commit, state: journal.state, updated: Date.now() };

      await store.write(record);

      await save(record, journal);
    }

    throw failure;
  }

  return { commit: journal.target, state: "complete" };
}

async function recover(request, record, journal) {
  const failed = journal.state === "failed:application";
  const cleanup = journal.error === "UPDATE_OWNER";
  const installed = record.source?.commit === request.target;
  const excluded = record.source?.state === "failed:application";
  const resumable = failed && cleanup && installed && excluded;

  git.check(
    resumable,
    "RECOVERY",
    "Only an installed target with failed cleanup can recover forward.",
  );

  git.check(
    journal.directory === path.child(path.source, ".update-" + request.id),
    "OWNER",
    "Recovery must use the original Update temporary directory.",
  );

  git.check(
    journal.packages.length === source.packages.length,
    "SOURCE",
    "Recovery requires every prepared package.",
  );

  await intact(journal.configs);

  for (const name of source.packages) {
    const prepared = journal.packages.find((entry) => entry.name === name);

    git.check(prepared, "SOURCE", "Recovery package evidence is missing.");

    const directory = path.folder(name);
    const latest = await source.verify(record, directory);

    git.check(
      JSON.stringify(latest) === JSON.stringify(prepared.latest),
      "SOURCE",
      "Installed Source does not match the prepared target.",
    );

    for (const variable of prepared.variables) {
      const filename = path.child(directory, variable.name);

      git.check(
        (await store.digest(filename)) === variable.digest,
        "ENV",
        "Recovery environment differs from the preserved configuration.",
      );
    }
  }

  const original = await database(record);

  git.check(
    JSON.stringify(original) === JSON.stringify(journal.database),
    "DATABASE",
    "Recovery database role, process, Cluster or Timeline changed.",
  );

  const selected = selection(record);
  const option = { locked: true, monitor: true, upgrade: false };

  try {
    await source.remove(record, journal.directory);

    await service.execute("start", selected, option);

    await ready(selected);

    await intact(journal.configs);

    const latest = await database(record);

    git.check(
      JSON.stringify(latest) === JSON.stringify(journal.database),
      "DATABASE",
      "Database identity changed during recovery.",
    );

    record.source.state = "complete";
    record.source.updated = Date.now();
    journal.state = "applied";

    delete journal.error;

    await store.write(record);

    await save(record, journal);
  } catch (failure) {
    try {
      await service.execute("stop", selected, option);
    } catch (cleanup) {
      throw new AggregateError(
        [failure, cleanup],
        "UPDATE_STOP: Failed to exclude the recovering Node.",
        { cause: cleanup },
      );
    } finally {
      record.source.state = "failed:application";
      journal.state = "failed:application";
      journal.error = failure.code ?? "UPDATE_RECOVERY";

      await store.write(record);

      await save(record, journal);
    }

    throw failure;
  }

  return { commit: request.target, state: "complete" };
}

async function settle(request, record, journal) {
  const failed = journal.state === "failed:application";
  const stopped = journal.error === "system";
  const installed = record.source?.commit === request.target;
  const excluded = record.source?.state === "failed:application";
  const applied = journal.package === "cli";
  const valid = failed && stopped && installed && excluded && applied;

  git.check(
    valid,
    "RECOVERY",
    "Only a fully installed target with recovered services can finish.",
  );

  git.check(
    journal.directory === path.child(path.source, ".update-" + request.id),
    "OWNER",
    "Finish must use the original Update temporary directory.",
  );

  git.check(
    journal.packages.length === source.packages.length,
    "SOURCE",
    "Every prepared package must be preserved.",
  );

  await intact(journal.configs);

  for (const name of source.packages) {
    const prepared = journal.packages.find((entry) => entry.name === name);

    git.check(prepared, "SOURCE", "Prepared package evidence is missing.");

    const directory = path.folder(name);
    const latest = await source.verify(record, directory);

    git.check(
      JSON.stringify(latest) === JSON.stringify(prepared.latest),
      "SOURCE",
      "Installed Source differs from the prepared target.",
    );

    for (const variable of prepared.variables) {
      git.check(
        (await store.digest(path.child(directory, variable.name))) ===
          variable.digest,
        "ENV",
        "An environment file changed after application.",
      );
    }
  }

  const before = await database(record);

  for (const name of ["cluster", "timeline", "recovery"]) {
    git.check(
      before?.[name] === journal.database?.[name],
      "DATABASE",
      "Database identity or role changed after application.",
    );
  }

  const reports = await health.health(record, { timeout: 3000 });
  const selected = selection(record);

  for (const service of selected.services) {
    const report = reports.find((entry) => entry.name === service.name);

    let ready = false;

    if (report) {
      ready = health.up(report);
    }

    git.check(
      ready,
      "HEALTH",
      "Every recovered service must be healthy before finishing.",
    );
  }

  if (before) {
    const report = reports.find((entry) => entry.role === "DB");
    const replication = report?.replication;

    if (before.recovery) {
      const readonly = replication?.readonly === "on";
      const streaming = replication?.receiver?.status === "streaming";
      const ready = readonly && streaming;

      git.check(
        ready,
        "DATABASE",
        "The recovered Replica must remain read-only and streaming.",
      );
    } else {
      git.check(
        replication?.readonly === "off",
        "DATABASE",
        "The current Primary must remain writable.",
      );
    }
  }

  const after = await database(record);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);

  git.check(
    unchanged,
    "DATABASE",
    "Database process or identity changed during verification.",
  );

  await intact(journal.configs);

  await source.remove(record, journal.directory);

  record.source.state = "complete";
  record.source.updated = Date.now();

  await store.write(record);
}

export async function run(request, option = {}) {
  command.root();

  option.signal?.throwIfAborted();

  let record = await store.read();

  git.check(
    record?.installed,
    "INSTALLATION",
    "Orbit is not installed on this Node.",
  );

  git.check(git.sha(request.target), "TARGET", "Invalid fixed target commit.");

  git.check(
    /^[a-f0-9-]{36}$/u.test(request.id ?? ""),
    "ID",
    "Invalid Update ID.",
  );

  if (request.action === "info") {
    const value = await read();
    const reports = await health.health(record, { timeout: 3000 });

    return {
      commit: record.source?.commit ?? null,
      state: record.source?.state ?? "unknown",
      update: value?.state ?? null,
      reports: reports.map(
        ({ name, role, state, live, ready, mode, replication }) => {
          const result = { name, role, state, live, ready, mode, replication };

          return result;
        },
      ),
    };
  }

  if (request.action === "status") {
    const journal = await read();

    if (journal) {
      git.check(
        finished.includes(journal.state),
        "PENDING",
        "A prior Update requires administrator recovery first.",
      );
    }

    for (const name of source.packages) {
      const directory = path.folder(name);

      if (await store.exists(directory)) {
        await source.verify(record, directory);
      }
    }

    const value = await git.inspect(request.checkout, {
      target: request.target,
      installed: path.source,
    });

    git.guard(value);

    return {
      ...value,
      commit: record.source?.commit ?? null,
      state: record.source?.state ?? "unknown",
      services: record.services.map(({ name, role }) => {
        const result = { name, role };

        return result;
      }),
    };
  }

  const release = await lock("update", { wait: true, signal: option.signal });

  let services;

  try {
    services = await lock("service", { wait: true, signal: option.signal });
    record = await store.read();

    if (request.action === "prepare") {
      return await prepare(request, record, option);
    }

    const journal = await read();
    const identity = journal?.id === request.id;
    const target = journal?.target === request.target;
    const matching = identity && target;

    git.check(
      matching,
      "ID",
      "Update journal does not match the fixed target and ID.",
    );

    if (request.action === "apply") {
      return await apply(request, record, journal);
    }

    if (request.action === "recover") {
      return await recover(request, record, journal);
    }

    if (request.action === "finish") {
      if (journal.state === "failed:application") {
        await settle(request, record, journal);
      } else {
        git.check(
          journal.state === "applied",
          "STATE",
          "The applied Node has not been verified.",
        );
      }

      git.check(
        record.source?.commit === request.target,
        "COMMIT",
        "Installed Source does not match the fixed target.",
      );

      journal.state = "complete";

      await save(record, journal);

      return { commit: request.target, state: journal.state };
    }

    if (request.action === "cancel") {
      const prepared = journal.state === "prepared";
      const failed = journal.state === "failed:preparation";
      const safe = prepared || failed;

      git.check(
        safe,
        "RECOVERY",
        "A partially applied Update requires administrator recovery.",
      );

      await source.remove(record, journal.directory);

      journal.state = "cancelled";

      await save(record, journal);

      return { state: journal.state };
    }

    git.check(false, "ACTION", "Unsupported Update action.");
  } finally {
    if (services) {
      await services();
    }

    await release();
  }
}

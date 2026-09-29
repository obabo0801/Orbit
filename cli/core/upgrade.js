import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as record from "#cli/core/record.js";
import * as system from "#cli/core/system.js";
import * as command from "#cli/core/process.js";
import * as config from "#cli/core/config.js";
import * as template from "#cli/core/template.js";
import { error } from "#cli/core/error.js";
import * as migration from "#cli/core/migration.js";
import * as tools from "#cli/core/tools.js";

async function sources() {
  const files = new Map();

  async function visit(name) {
    if (files.has(name)) {
      return;
    }

    const filename = path.child(path.checkout, name);
    const contents = await fs.readFile(filename, "utf8");

    files.set(name, contents);

    const imports = contents.matchAll(/from\s+["']#cli\/([^"']+)["']/gu);

    for (const match of imports) {
      await visit(`cli/${match[1]}`);
    }
  }

  await visit("cli/monitor.js");

  await visit("cli/core/upgrade.js");

  await visit("cli/core/uninstall.js");

  await visit("cli/core/service.js");

  await visit("cli/view/events.js");

  await visit("cli/view/service.js");

  await visit("cli/locale/ko.js");

  await visit("cli/locale/en.js");

  await visit("cli/platform/mac/runner.js");

  await visit("cli/boot.js");

  await visit("cli/shutdown.js");

  const name = "cli/platform/windows/startup.ps1";
  const filename = path.child(path.checkout, name);
  const contents = await fs.readFile(filename, "utf8");

  files.set(name, contents);

  return files;
}

async function authorized(manifest, filename) {
  await store.safe(filename);

  const details = await store.exists(filename);

  if (!details) {
    return;
  }

  const entry = store.entry(manifest, filename);

  let valid = !entry;

  if (!valid) {
    valid = !store.secure(details);
  }

  if (valid) {
    throw error("changed");
  }

  const hash = await store.digest(filename);

  if (hash !== entry.hash) {
    throw error("changed");
  }
}

async function directory(manifest, filename) {
  const details = await store.exists(filename);

  if (details) {
    const folder = store.folder(details);
    const root = details.uid === 0;
    const owned = folder && root;

    if (!owned) {
      throw error("changed");
    }

    return;
  }

  const parent = path.parent(filename);

  await directory(manifest, parent);

  await store.directory(manifest, filename);
}

async function refresh(manifest, filename) {
  const entry = store.entry(manifest, filename);
  const details = await store.exists(filename);

  let valid = !entry;

  if (!valid) {
    valid = !details;
  }

  if (valid) {
    return;
  }

  await store.safe(filename);

  if (!store.secure(details)) {
    throw error("changed");
  }

  entry.hash = await store.digest(filename);
}

async function copy(manifest, files) {
  for (const [name, contents] of files) {
    const filename = path.child(path.source, name);
    const parent = path.parent(filename);

    await directory(manifest, parent);

    const entry = store.entry(manifest, filename);
    const details = await store.exists(filename);

    if (details) {
      const previous = await fs.readFile(filename, "utf8");

      if (previous === contents) {
        continue;
      }
    }

    if (!entry) {
      await store.file(manifest, filename, contents);

      continue;
    }

    const temporary = path.adjacent(filename, ".monitor-upgrade.tmp");
    const mode = entry.mode ?? 0o644;
    const file = await fs.open(temporary, "wx", mode);

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

    entry.hash = await store.digest(filename);
    entry.done = true;

    await store.write(manifest);
  }
}

export async function monitor(manifest) {
  command.root();

  const observer = {
    name: "Monitor",
    role: "MONITOR",
    unit: "orbit-monitor.service",
  };

  const unit = path.unit(observer.unit);
  const files = await sources();

  const tracked = manifest.services.some((service) => {
    return service.role === "MONITOR";
  });

  const required = [unit, path.monitoring, path.history];

  for (const name of files.keys()) {
    required.push(path.child(path.source, name));
  }

  const presence = await Promise.all(required.map(store.exists));

  const changes = await Promise.all(
    [...files].map(async ([name, contents]) => {
      const filename = path.child(path.source, name);
      const previous = await fs.readFile(filename, "utf8").catch(() => null);

      return previous !== contents;
    }),
  );

  const previous = await fs.readFile(unit, "utf8").catch(() => null);
  const generated = template.observer(manifest.tools.node);
  const contents = template.preserve(generated, previous);

  let checked;

  if (tracked) {
    checked = presence.every(Boolean);
  }

  let complete = tracked && checked;

  if (complete) {
    complete = !changes.some(Boolean);
  }

  if (complete) {
    complete = previous === contents;
  }

  if (complete) {
    return;
  }

  const state = await system.state(observer);
  const owned = store.entry(manifest, unit);

  let outcome = !tracked;

  if (outcome) {
    outcome = !owned;
  }

  if (outcome) {
    outcome = state.LoadState !== "not-found";
  }

  if (outcome) {
    throw error("collision");
  }

  for (const name of files.keys()) {
    await authorized(manifest, path.child(path.source, name));
  }

  if (await store.exists(unit)) {
    await authorized(manifest, unit);
  }

  const directory = await store.exists(path.monitoring);

  if (directory) {
    const owned = store.entry(manifest, path.monitoring);

    let selection = !owned;

    if (!selection) {
      selection = !store.folder(directory);
    }

    if (!selection) {
      selection = directory.uid !== 0;
    }

    if (selection) {
      throw error("changed");
    }
  }

  const running = state.ActiveState === "active";

  if (running) {
    await system.adapter().stop(observer);
  }

  try {
    await copy(manifest, files);

    await record.register(manifest, manifest.tools.node);

    await system.validate([observer]);

    await system.reload();
  } finally {
    if (running) {
      await system.adapter().start(observer);
    }
  }

  const preferences = await config.config();

  if (preferences.startup) {
    await system.startup(manifest, true);
  }
}

export async function database(manifest, option = {}) {
  command.root();

  const files = new Map();
  const source = option.source ?? path.checkout;

  if (!path.absolute(source)) {
    throw error("changed");
  }

  async function visit(name) {
    const filename = path.child(source, name);
    const details = await fs.lstat(filename);

    if (details.isSymbolicLink()) {
      throw error("changed");
    }

    if (details.isDirectory()) {
      for (const entry of await fs.readdir(filename)) {
        await visit(`${name}/${entry}`);
      }

      return;
    }

    if (!details.isFile()) {
      throw error("changed");
    }

    files.set(name, await fs.readFile(filename, "utf8"));
  }

  const names = [
    "db/core",
    "db/schema",
    "db/migration",
    "db/migrate.js",
    "db/backup.js",
    "db/package.json",
    "db/pnpm-lock.yaml",
    "cli/backup.js",
    "cli/core/backup.js",
    "cli/core/schedule.js",
    "cli/platform/linux/schedule.js",
    "cli/platform/mac/schedule.js",
    "cli/core/manifest.js",
    "cli/core/uninstall.js",
  ];

  for (const name of names) {
    await visit(name);
  }

  for (const name of files.keys()) {
    await authorized(manifest, path.child(path.source, name));
  }

  await copy(manifest, files);

  const prepared = [];

  try {
    manifest.tools.pnpm = await tools.resolve("pnpm", {
      supplied: manifest.tools.pnpm,
      prepared,
    });

    await tools.commit(manifest, prepared, { extend: true });

    const reused = prepared.length === 0;
    const changed = manifest.provenance?.pnpm?.path !== manifest.tools.pnpm;
    const refreshed = reused && changed;

    if (refreshed) {
      const managed = Boolean(store.entry(manifest, manifest.tools.pnpm));

      let owner;

      if (managed) {
        owner = "orbit";
      } else {
        owner = "system";
      }

      manifest.provenance ??= {};
      manifest.provenance.pnpm = { owner, path: manifest.tools.pnpm };
    }

    await store.write(manifest);
  } finally {
    await tools.cleanup(prepared);
  }

  const cwd = path.folder("db");
  const metadata = path.child(cwd, "node_modules/.modules.yaml");

  await authorized(manifest, metadata);

  const args = [
    "install",
    "--prod",
    "--frozen-lockfile",
    "--store-dir",
    path.store,
  ];

  const setting = { cwd, timeout: 300000 };

  try {
    await command.run(manifest.tools.pnpm, args, setting);
  } finally {
    await refresh(manifest, metadata);

    await store.inventory(manifest, cwd);

    await store.write(manifest);
  }

  if (option.migrate === false) {
    return "";
  }

  return await migration.run(manifest);
}

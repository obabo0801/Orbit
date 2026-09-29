import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as git from "#cli/core/git.js";
import { error } from "#cli/core/error.js";

export const packages = ["cli", "web", "was", "db"];

export function ignored(name) {
  const generated = ["node_modules", ".local", "dist", ".git"].includes(name);
  const environment = name.startsWith(".env");
  const result = generated || environment;

  return result;
}

export async function copy(record, origin, destination) {
  await store.directory(record, destination);

  for (const entry of await fs.readdir(origin, { withFileTypes: true })) {
    if (ignored(entry.name)) {
      continue;
    }

    const source = path.child(origin, entry.name);
    const target = path.child(destination, entry.name);

    if (entry.isDirectory()) {
      await copy(record, source, target);
    } else if (entry.isFile()) {
      await store.file(record, target, await fs.readFile(source));
    } else {
      throw error("config");
    }
  }
}

export async function fingerprint(directory) {
  const entries = [];

  async function visit(folder, prefix) {
    const files = await fs.readdir(folder, { withFileTypes: true });

    files.sort((left, right) => left.name.localeCompare(right.name));

    for (const file of files) {
      if (ignored(file.name)) {
        continue;
      }

      const filename = path.child(folder, file.name);
      const name = prefix + file.name;

      if (file.isDirectory()) {
        await visit(filename, name + "/");
      } else {
        git.check(
          file.isFile(),
          "SOURCE",
          "Source contains an unsupported file or link.",
        );

        entries.push([name, await store.digest(filename)]);
      }
    }
  }

  await visit(directory, "");

  return entries;
}

export async function verify(record, directory) {
  const files = await fingerprint(directory);
  const names = new Set(files.map(([name]) => name));
  const prefix = directory + "/";

  for (const entry of record.entries) {
    const regular = entry.type === "file";
    const contained = entry.path.startsWith(prefix);
    const tracked = regular && contained;

    if (!tracked) {
      continue;
    }

    const name = entry.path.slice(prefix.length);
    const generated = name.split("/").some(ignored);

    if (!generated) {
      git.check(names.has(name), "SOURCE", "Installed Source is incomplete.");
    }
  }

  for (const [name, digest] of files) {
    const filename = path.child(directory, name);
    const entry = store.entry(record, filename);
    const registered = entry?.hash === digest;

    git.check(
      registered,
      "OWNER",
      "Installed Source changed or contains an unmanaged file.",
    );
  }

  return files;
}

export async function remove(record, directory) {
  const parent = path.parent(directory) === path.source;
  const name = directory.slice(path.source.length + 1);
  const temporary = /^\.update-[a-f0-9-]{36}$/u.test(name);
  const canonical = path.normalized(directory) === directory;
  const owned = store.entry(record, directory)?.type === "directory";
  const valid = parent && temporary && canonical && owned;

  git.check(valid, "OWNER", "Use an owned Update temporary directory.");

  await store.safe(directory);

  const root = await store.exists(directory);

  if (root) {
    const folder = store.folder(root);
    const owner = root.uid === 0;
    const restricted = (root.mode & 0o077) === 0;
    const secure = folder && owner && restricted;

    git.check(secure, "OWNER", "Update temporary directory is not private.");
  }

  const prefix = directory + "/";

  const entries = record.entries.filter((entry) => {
    const root = entry.path === directory;
    const child = entry.path.startsWith(prefix);
    const included = root || child;

    return included;
  });

  const registered = new Map(entries.map((entry) => [entry.path, entry]));
  const generated = new Set();

  async function visit(filename) {
    await store.safe(filename);

    const details = await fs.lstat(filename);
    const existing = registered.get(filename);
    const environment = filename.split("/").at(-1).startsWith(".env");

    if (!existing) {
      git.check(
        !environment,
        "OWNER",
        "An unmanaged environment file was preserved.",
      );

      git.check(
        !details.isSymbolicLink(),
        "OWNER",
        "An unmanaged temporary link was preserved.",
      );

      const regular = details.isFile();
      const folder = details.isDirectory();
      const supported = regular || folder;

      git.check(supported, "OWNER", "Unsupported generated artifact.");

      let type;

      if (folder) {
        type = "directory";
      } else {
        type = "file";
      }

      entries.push({ path: filename, type: type });
    }

    if (!environment) {
      generated.add(filename);
    }

    if (details.isDirectory()) {
      for (const name of await fs.readdir(filename)) {
        await visit(path.child(filename, name));
      }
    }
  }

  for (const section of ["input", "next", "before"]) {
    for (const name of packages) {
      const modules = path.child(directory, `${section}/${name}/node_modules`);
      const details = await store.exists(modules);

      if (details) {
        git.check(
          store.folder(details),
          "OWNER",
          "Generated artifacts must use a real package directory.",
        );

        await visit(modules);
      }
    }
  }

  entries.sort((left, right) => right.path.length - left.path.length);

  for (const entry of entries) {
    const details = await store.exists(entry.path);

    if (!details) {
      continue;
    }

    await store.safe(entry.path);

    if (entry.type === "directory") {
      git.check(store.folder(details), "OWNER", "Temporary directory changed.");
    } else if (entry.type === "file") {
      git.check(details.isFile(), "OWNER", "Temporary file type changed.");

      if (generated.has(entry.path)) {
        continue;
      }

      git.check(
        (await store.digest(entry.path)) === entry.hash,
        "OWNER",
        "Temporary source changed; it was preserved.",
      );
    } else if (entry.type === "link") {
      git.check(details.isSymbolicLink(), "OWNER", "Temporary link changed.");

      git.check(
        (await fs.readlink(entry.path)) === entry.target,
        "OWNER",
        "Temporary link changed; it was preserved.",
      );
    } else {
      git.check(false, "OWNER", "Unexpected temporary source ownership type.");
    }
  }

  for (const entry of entries) {
    if (!(await store.exists(entry.path))) {
      continue;
    }

    await store.safe(entry.path);

    if (entry.type === "directory") {
      await fs.rmdir(entry.path);
    } else {
      await fs.unlink(entry.path);
    }
  }

  const removed = new Set(entries);

  record.entries = record.entries.filter((entry) => {
    const retained = !removed.has(entry);

    return retained;
  });

  await store.write(record);
}

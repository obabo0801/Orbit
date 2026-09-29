import * as location from "node:path";
import * as url from "node:url";
import { env } from "node:process";

export function environment() {
  let valid = env.DB_CONFIG !== undefined;

  if (valid) {
    valid = env.DB_CONFIG !== null;
  }

  if (valid) {
    return env.DB_CONFIG;
  }

  return local("../.env");
}

export function absolute(filename) {
  return location.isAbsolute(filename);
}

export function path(settings = {}) {
  const schema = local("../schema/");
  const migration = local("../migration/");
  const runtime = {};

  for (const name of ["backup", "restore", "temporary"]) {
    const directory = settings[name];
    const optional = name === "restore";

    let missing = directory === undefined;

    if (!missing) {
      missing = directory === "";
    }

    if (optional && missing) {
      continue;
    }

    let absolute = typeof directory === "string";

    if (absolute) {
      absolute = directory.trim();
    }

    if (absolute) {
      absolute = location.isAbsolute(directory);
    }

    if (!absolute) {
      throw new Error(`DATABASE_PATH: Specify an absolute ${name} directory.`);
    }

    runtime[name] = location.resolve(directory);
  }

  const directories = Object.values(runtime);
  const source = local("../../");

  for (const directory of directories) {
    let valid = contains(source, directory);

    if (!valid) {
      valid = contains(directory, source);
    }

    if (valid) {
      throw new Error(
        "DATABASE_PATH: Runtime directories must be outside Source.",
      );
    }

    for (const other of directories) {
      let outcome = directory !== other;

      if (outcome) {
        outcome = contains(directory, other);
      }

      if (outcome) {
        throw new Error("DATABASE_PATH: Runtime directories must not overlap.");
      }
    }
  }

  if (new Set(directories).size !== directories.length) {
    throw new Error("DATABASE_PATH: Runtime directories must be distinct.");
  }

  const paths = { schema, migration, ...runtime };

  return Object.freeze(paths);
}

function local(filename) {
  const address = new url.URL(filename, import.meta.url);

  return url.fileURLToPath(address);
}

function contains(parent, child) {
  const remainder = location.relative(parent, child);

  if (remainder === "") {
    return true;
  }

  const absolute = location.isAbsolute(remainder);

  let outside = remainder === "..";

  if (!outside) {
    outside = remainder.startsWith(`..${location.sep}`);
  }

  let result = !absolute;

  if (result) {
    result = !outside;
  }

  return result;
}

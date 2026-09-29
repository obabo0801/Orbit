import { env, loadEnvFile } from "node:process";
import {
  existsSync,
  openSync,
  writeFileSync,
  closeSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "#db/core/path.js";

export function load(defaults, scope = "DATABASE_CONFIG") {
  const filename = path.environment();

  if (!path.absolute(filename)) {
    throw new Error(`${scope}: Specify an absolute configuration path.`);
  }

  const supplied = env.DB_CONFIG !== undefined;
  const configured = env.DB_CONFIG !== null;
  const explicit = supplied && configured;
  const installed = env.ORBIT_SYSTEM === "1";
  const production = env.NODE_ENV === "production";
  const defaulted = !explicit;
  const uninstalled = !installed;
  const development = !production;
  const local = defaulted && uninstalled && development;

  let missing = false;

  if (local) {
    missing = !existsSync(filename);
  }

  const initialize = local && missing;

  if (initialize) {
    const lines = Object.entries(defaults).map(function entry([name, value]) {
      const text = name + "=" + value;

      return text;
    });

    const contents = lines.join("\n") + "\n";
    const temporary = filename + "." + randomUUID() + ".tmp";

    try {
      const descriptor = openSync(temporary, "wx", 0o600);

      try {
        try {
          writeFileSync(descriptor, contents);
        } finally {
          closeSync(descriptor);
        }

        try {
          linkSync(temporary, filename);
        } catch (cause) {
          if (cause.code !== "EEXIST") {
            throw cause;
          }
        }
      } finally {
        unlinkSync(temporary);
      }
    } catch (cause) {
      throw new Error(`${scope}: Could not initialize the environment file.`, {
        cause,
      });
    }
  }

  try {
    loadEnvFile(filename);
  } catch (cause) {
    throw new Error(`${scope}: Could not read the environment file.`, {
      cause,
    });
  }
}

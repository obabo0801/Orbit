import * as fs from "node:fs/promises";
import process from "node:process";
import * as connection from "#db/core/connection.js";
import * as backup from "#db/core/backup.js";
import * as environment from "#db/core/environment.js";
import { defaults } from "#db/core/config.js";

const controller = new globalThis.AbortController();

function interrupt() {
  controller.abort();
}

process.on("SIGINT", interrupt);

process.on("SIGTERM", interrupt);

try {
  environment.load(defaults, "BACKUP_CONFIG");

  const operation = process.argv[2];
  const filename = process.env.DB_BACKUP_CONFIG;
  const policy = JSON.parse(await fs.readFile(filename, "utf8"));
  const settings = await connection.config();
  const signal = controller.signal;
  const id = process.argv[3];
  const option = { ...policy, signal, id, ca: process.env.DB_CA };

  const methods = {
    backup: backup.create,
    verify: backup.verify,
    restore: backup.restore,
    prune: backup.clean,
  };

  const execute = methods[operation];

  if (!execute) {
    throw new Error("BACKUP_COMMAND: Invalid operation.");
  }

  const result = await execute(settings, option);

  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const recognized = error.message.startsWith("BACKUP_");

  let message;

  if (recognized) {
    message = error.message;
  } else {
    message = "BACKUP_FAILED: Operation failed.";
  }

  process.stderr.write(message + "\n");

  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);

  process.removeListener("SIGTERM", interrupt);
}

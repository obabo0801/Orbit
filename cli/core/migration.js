import * as path from "#cli/core/path.js";
import * as system from "#cli/core/system.js";
import * as command from "#cli/core/process.js";
import { error } from "#cli/core/error.js";
import { setTimeout as delay } from "node:timers/promises";
import * as primary from "#cli/core/primary.js";
import * as fs from "node:fs/promises";
import { parseEnv } from "node:util";

export async function run(manifest) {
  command.root();

  await primary.guard("migration");

  const service = manifest.services.find((entry) => {
    const db = entry.role === "DB";
    const primary = entry.mode !== "replica";
    const target = db && primary;

    return target;
  });

  if (!service) {
    throw error("installation");
  }

  const state = await system.state(service);
  const running = state.ActiveState === "active";
  const adapter = system.adapter();

  if (!running) {
    await adapter.start(service);
  }

  try {
    const executable = path.child(manifest.tools.postgres, "pg_isready");
    const args = ["-h", "127.0.0.1", "-p", String(service.port)];
    const checking = { allow: true, timeout: 5000 };

    let ready = false;

    for (let attempt = 0; attempt < 30; attempt++) {
      const report = await command.run(executable, args, checking);

      if (report.code === 0) {
        ready = true;

        break;
      }

      await delay(100);
    }

    if (!ready) {
      throw error("system");
    }

    const entry = path.file("db", "migrate.js");
    const variables = parseEnv(await fs.readFile(path.database, "utf8"));

    const env = {
      ...variables,
      DB_CONFIG: path.database,
      NODE_ENV: "production",
    };

    const option = { env, timeout: 300000, allow: true };
    const report = await command.run(manifest.tools.node, [entry], option);

    if (report.code !== 0) {
      const diagnostic = report.diagnostic.trim();
      const recognized = /^MIGRATION_[A-Z]+: [^\r\n]+$/u.test(diagnostic);

      let message;

      if (recognized) {
        message = diagnostic;
      } else {
        message = "MIGRATION_FAILED: Could not complete migration.";
      }

      throw new Error(message);
    }

    return report.output;
  } finally {
    if (!running) {
      await adapter.stop(service);
    }
  }
}

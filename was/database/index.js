import process from "node:process";
import { Console } from "node:console";
import { config } from "#was/core/config.js";
import * as connection from "#was/database/connection.js";

const log = new Console(process.stdout, process.stderr);

try {
  const settings = config();

  connection.initialize(settings.database);

  const report = await connection.status();

  log.info(`DATABASE_STATUS: ${report.state}`);

  if (report.state !== "ready") {
    process.exitCode = 1;
  }
} catch {
  log.error("DATABASE_CHECK: Could not initialize the database check.");

  process.exitCode = 1;
} finally {
  try {
    await connection.close();
  } catch {
    log.error("DATABASE_CLOSE: Could not close the database pool.");

    process.exitCode = 1;
  }
}

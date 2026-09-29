import process from "node:process";
import * as url from "node:url";
import * as connection from "#db/core/connection.js";
import * as migration from "#db/core/migration.js";

try {
  const address = new url.URL("./migration/", import.meta.url);
  const directory = url.fileURLToPath(address);
  const settings = await connection.config();
  const option = { directory };
  const report = await migration.run(settings, option);

  process.stdout.write(
    `MIGRATION_COMPLETE: ${report.applied} applied, ${report.total} total.\n`,
  );
} catch (error) {
  let message;

  if (error.message.startsWith("MIGRATION_")) {
    message = error.message;
  } else {
    message = "MIGRATION_FAILED: Could not complete migration.";
  }

  process.stderr.write(message + "\n");

  process.exitCode = 1;
}

import process from "node:process";
import * as config from "#cli/core/config.js";
import * as backup from "#cli/core/backup.js";
import * as system from "#cli/core/system.js";

try {
  process.env.ORBIT_SYSTEM = "1";

  const manifest = await config.installation();

  if (manifest?.installed) {
    const policy = await backup.prepare(manifest);

    if (policy.enabled) {
      const service = manifest.services.find((entry) => {
        return entry.role === "DB";
      });

      const state = await system.state(service);

      if (state.ActiveState === "active") {
        const result = await backup.run(manifest, "backup");

        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        process.stdout.write("BACKUP_SKIPPED: Database stopped.\n");
      }
    }
  }
} catch (error) {
  const recognized = error.message.startsWith("BACKUP_");

  let message;

  if (recognized) {
    message = error.message;
  } else {
    message = "BACKUP_FAILED: Scheduled backup failed.";
  }

  process.stderr.write(message + "\n");

  process.exitCode = 1;
}

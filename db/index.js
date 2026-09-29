import process from "node:process";
import { Console } from "node:console";
import { config } from "#db/core/config.js";

const log = new Console(process.stdout, process.stderr);

try {
  const directories = config();

  for (const [name, directory] of Object.entries(directories)) {
    log.info(`${name}: ${directory}`);
  }
} catch (error) {
  log.error(error.message);

  process.exitCode = 1;
}

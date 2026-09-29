import * as process from "node:process";
import * as path from "#db/core/path.js";
import * as environment from "#db/core/environment.js";

export const defaults = Object.freeze({
  DB_ENABLED: "false",
  DB_HOST: "",
  DB_PORT: "5432",
  DB_NAME: "",
  DB_USER: "",
  DB_PASSWORD: "",
  DB_SSL: "true",
  DB_CA: "",
  DB_TIMEOUT: "5000",
  DB_MIGRATION_TIMEOUT: "30000",
  DB_BACKUP_CONFIG: "",
  DB_BACKUP_PATH: "",
  DB_RESTORE_PATH: "",
  DB_TEMPORARY_PATH: "",
});

export function config() {
  environment.load(defaults);

  const backup = process.env.DB_BACKUP_PATH ?? defaults.DB_BACKUP_PATH;
  const restore = process.env.DB_RESTORE_PATH ?? defaults.DB_RESTORE_PATH;
  const temporary = process.env.DB_TEMPORARY_PATH ?? defaults.DB_TEMPORARY_PATH;
  const settings = { backup, restore, temporary };

  return path.path(settings);
}

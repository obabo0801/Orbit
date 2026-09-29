import { env } from "node:process";
import * as url from "node:url";
import { isAbsolute } from "node:path";

export function environment() {
  let valid = env.WAS_CONFIG !== undefined;

  if (valid) {
    valid = env.WAS_CONFIG !== null;
  }

  if (valid) {
    return env.WAS_CONFIG;
  }

  const address = new url.URL("../.env", import.meta.url);

  return url.fileURLToPath(address);
}

export function absolute(filename) {
  return isAbsolute(filename);
}

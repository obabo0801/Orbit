import * as process from "node:process";
import * as database from "#was/database/config.js";
import { readFileSync } from "node:fs";
import * as path from "#was/core/path.js";
import { isIP } from "node:net";
import * as environment from "#was/core/environment.js";

export const defaults = Object.freeze({
  WAS_HOST: "127.0.0.1",
  WAS_PORT: "3000",
  WAS_PRIVATE: "",
  WAS_CERT: "",
  WAS_KEY: "",
  ...database.defaults,
});

export function config() {
  environment.load(defaults);

  const host = process.env.WAS_HOST ?? defaults.WAS_HOST;
  const text = process.env.WAS_PORT ?? defaults.WAS_PORT;
  const port = Number(text);

  let invalid = !host.trim();

  if (!invalid) {
    invalid = host !== host.trim();
  }

  if (invalid) {
    throw new Error("WAS_HOST: Specify a nonempty host without outer spaces.");
  }

  const digits = /^\d+$/.test(text);

  let range = port >= 1;

  if (range) {
    range = port <= 65535;
  }

  let rejected = !digits;

  if (!rejected) {
    rejected = !range;
  }

  if (rejected) {
    throw new Error("WAS_PORT: Specify an integer from 1 to 65535.");
  }

  const connection = database.config();
  const addresses = new Set([host]);

  if (process.env.WAS_PRIVATE) {
    for (const address of process.env.WAS_PRIVATE.split(",")) {
      if (isIP(address) !== 4) {
        throw new Error("WAS_HOST: Specify private IPv4 listeners.");
      }

      const [first, second] = address.split(".").map(Number);
      const network = first === 100;
      const minimum = second >= 64;
      const maximum = second <= 127;
      const eligible = network && minimum && maximum;

      if (!eligible) {
        throw new Error("WAS_HOST: Specify Tailscale private listeners.");
      }

      addresses.add(address);
    }
  }

  let tls;
  let secured = process.env.WAS_CERT;

  if (!secured) {
    secured = process.env.WAS_KEY;
  }

  if (secured) {
    let unsupported = !path.absolute(process.env.WAS_CERT ?? defaults.WAS_CERT);

    if (!unsupported) {
      unsupported = !path.absolute(process.env.WAS_KEY ?? defaults.WAS_KEY);
    }

    if (unsupported) {
      throw new Error("WAS_TLS: Specify absolute certificate and key paths.");
    }

    const cert = readFileSync(process.env.WAS_CERT);
    const key = readFileSync(process.env.WAS_KEY);
    const minimum = "TLSv1.2";

    tls = { cert, key, minVersion: minimum };
  }

  let insecure = process.env.NODE_ENV === "production";

  if (insecure) {
    insecure = !tls;
  }

  if (insecure) {
    throw new Error("WAS_TLS: Production WAS requires TLS.");
  }

  const settings = {
    host,
    addresses: [...addresses],
    port,
    database: connection,
    tls,
  };

  return settings;
}

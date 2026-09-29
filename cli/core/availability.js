import { createConnection } from "node:net";
import { setTimeout } from "node:timers/promises";
import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as system from "#cli/core/system.js";
import { error } from "#cli/core/error.js";

function valid(port) {
  const integer = Number.isInteger(port);

  let range = port >= 1;

  if (range) {
    range = port <= 65535;
  }

  const result = integer && range;

  return result;
}

export async function wait(service) {
  if (!valid(service.port)) {
    throw error("manifest");
  }

  const addressed = service.address?.startsWith("https://");

  let host;

  if (addressed) {
    host = new URL(service.address).hostname;
  } else {
    host = "127.0.0.1";
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = await new Promise(function connect(resolve) {
      const port = service.port;
      const settings = { host, port };
      const socket = createConnection(settings);

      socket.setTimeout(500);

      socket.once("connect", function connected() {
        socket.destroy();

        resolve(true);
      });

      socket.once("timeout", function timeout() {
        socket.destroy();

        resolve(false);
      });

      socket.once("error", function failed() {
        resolve(false);
      });
    });

    if (ready) {
      if (service.role !== "DB") {
        return;
      }

      const manifest = await store.read();

      if (!manifest.tools?.postgres?.startsWith("/")) {
        throw error("manifest");
      }

      const report = await command.run(
        path.child(manifest.tools.postgres, "pg_isready"),
        ["-h", "127.0.0.1", "-p", String(service.port), "-t", "1"],
        { allow: true },
      );

      if (report.code === 0) {
        return;
      }
    }

    const report = await system.state(service);

    if (report.ActiveState === "failed") {
      throw error("system");
    }

    await setTimeout(100);
  }

  throw error("system");
}

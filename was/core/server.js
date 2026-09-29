import { createServer } from "node:http";
import { createServer as secure } from "node:https";
import process from "node:process";
import { Console } from "node:console";
import * as timers from "node:timers";
import { config } from "#was/core/config.js";
import * as connection from "#was/database/connection.js";
import { health } from "#was/core/health.js";

export function start() {
  const log = new Console(process.stdout, process.stderr);

  let settings;

  try {
    settings = config();

    connection.initialize(settings.database);
  } catch (error) {
    log.error(error.message);

    process.exitCode = 1;

    return;
  }

  const servers = settings.addresses.map(function create() {
    let server;

    if (settings.tls) {
      server = secure(settings.tls, serve);
    } else {
      server = createServer(serve);
    }

    return server;
  });

  let closing = false;

  async function serve(request, response) {
    request.on("error", discard);

    response.on("error", discard);

    request.resume();

    try {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");

      response.setHeader("Cache-Control", "no-store");

      let valid = request.method !== "GET";

      if (valid) {
        valid = request.method !== "HEAD";
      }

      if (valid) {
        response.writeHead(405, { Allow: "GET, HEAD" });

        response.end("WAS_METHOD: This resource only accepts GET and HEAD.\n");

        return;
      }

      if (["/live", "/ready"].includes(request.url)) {
        const report = await health(request.url.slice(1), closing);

        response.setHeader("Content-Type", "application/json; charset=utf-8");

        response.writeHead(report.code);

        response.end(JSON.stringify(report.data));

        return;
      }

      if (request.url !== "/") {
        response.writeHead(404);

        response.end("WAS_ROUTE: The requested resource was not found.\n");

        return;
      }

      response.writeHead(200);

      response.end("Orbit WAS\n");
    } catch {
      log.error("WAS_REQUEST: Could not complete the request.");

      let outcome = response.headersSent;

      if (!outcome) {
        outcome = response.destroyed;
      }

      if (outcome) {
        response.destroy();

        return;
      }

      response.writeHead(500);

      response.end("WAS_REQUEST: Could not complete the request.\n");
    }
  }

  function discard() {
    log.error("WAS_CONNECTION: The client connection could not complete.");
  }

  function stop() {
    if (closing) {
      return;
    }

    closing = true;

    const timer = timers.setTimeout(force, 5000);

    timer.unref();

    let remaining = servers.length;

    for (const server of servers) {
      server.close(function closed() {
        remaining -= 1;

        if (remaining === 0) {
          void finish();
        }
      });
    }

    function force() {
      for (const server of servers) {
        server.closeAllConnections();
      }

      log.error("WAS_STOP: The shutdown grace period expired.");

      process.exit(1);
    }

    async function finish() {
      try {
        await connection.close();

        log.info("WAS_STOP: The HTTP server and database pool have stopped.");
      } catch {
        log.error("WAS_STOP: Could not close the database pool.");

        process.exitCode = 1;
      } finally {
        timers.clearTimeout(timer);
      }
    }
  }

  function fatal() {
    log.error("WAS_FATAL: An unhandled process error requires shutdown.");

    process.exitCode = 1;

    stop();
  }

  function failure(error) {
    log.error(`WAS_BIND: Could not run the HTTP server (${error.code}).`);

    process.exitCode = 1;

    stop();
  }

  process.on("SIGINT", stop);

  process.on("SIGTERM", stop);

  process.on("uncaughtException", fatal);

  process.on("unhandledRejection", fatal);

  for (const [index, server] of servers.entries()) {
    const address = settings.addresses[index];

    server.on("error", failure);

    server.listen(settings.port, address, function ready() {
      log.info(`WAS_READY: Listening on ${address}:${settings.port}.`);
    });
  }
}

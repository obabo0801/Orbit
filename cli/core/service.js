import { lock } from "#cli/core/lock.js";
import { error } from "#cli/core/error.js";
import * as system from "#cli/core/system.js";
import * as upgrade from "#cli/core/upgrade.js";
import * as path from "#cli/core/path.js";
import * as intent from "#cli/core/intent.js";
import * as primary from "#cli/core/primary.js";

export async function execute(command, manifest, option = {}) {
  const adapter = option.adapter ?? system.adapter();

  if (!["start", "stop", "restart", "logs"].includes(command)) {
    throw error("unsupported");
  }

  let value = !manifest;

  if (!value) {
    value = !manifest.services.length;
  }

  if (value) {
    return "skipped";
  }

  if (!adapter) {
    throw error("unsupported");
  }

  if (command === "logs") {
    const services = system.units(manifest.services);

    await adapter.logs(services, option);

    return "complete";
  }

  let release;

  if (!option.locked) {
    release = await lock("service");
  }

  let request;

  try {
    let report = command === "start";

    if (report) {
      report = path.system();
    }

    if (report) {
      report = option.upgrade !== false;
    }

    if (report) {
      await upgrade.monitor(manifest).catch(() => undefined);
    }

    let candidates;

    if (
      manifest.services.some(function managed(service) {
        return service.unit;
      })
    ) {
      candidates = system.units(manifest.services);
    } else {
      candidates = manifest.services;
    }

    let role;

    if (option.target === "WEB") {
      role = "CADDY";
    } else {
      role = option.target;
    }

    let selected;

    if (role) {
      selected = candidates.filter((service) => {
        return service.role === role;
      });
    } else {
      selected = candidates;
    }

    const services = selected.filter((service) => {
      const start = command === "start";

      let monitor;

      if (!start) {
        monitor = service.role !== "MONITOR";
      }

      const requested = option.monitor === true;
      const included = start || monitor;
      const result = included || requested;

      return result;
    });

    if (path.system()) {
      request = await intent.begin(command, services, manifest);
    } else {
      request = null;
    }

    async function act(action, service) {
      if (action === "start") {
        await primary.guard(service.role, option);
      }

      try {
        await adapter[action](service, option);
      } catch (failure) {
        if (request) {
          const setting = { failed: true };

          await intent.finish(request, service, action, setting);
        }

        throw failure;
      }

      if (request) {
        const setting = { changed: true };

        await intent.finish(request, service, action, setting);
      }
    }

    let changed = false;
    let received = command === "stop";

    if (!received) {
      received = command === "restart";
    }

    if (received) {
      for (const service of [...services].reverse()) {
        if (await adapter.running(service)) {
          await act("stop", service);

          changed = true;
        } else if (request) {
          await intent.finish(request, service, "stop");
        }
      }
    }

    let candidate = command === "start";

    if (!candidate) {
      candidate = command === "restart";
    }

    if (candidate) {
      for (const service of services) {
        if (service.role === "MONITOR") {
          try {
            if (!(await adapter.running(service))) {
              await adapter.start(service);

              changed = true;
            }
          } catch {
            continue;
          }

          continue;
        }

        if (!(await adapter.running(service))) {
          await act("start", service);

          changed = true;
        } else if (request) {
          await intent.finish(request, service, "start");
        }
      }
    }

    let result;

    if (changed) {
      result = "complete";
    } else {
      result = "skipped";
    }

    return result;
  } finally {
    try {
      if (request) {
        await intent.end(request);
      }
    } finally {
      if (release) {
        await release();
      }
    }
  }
}

import { performance } from "node:perf_hooks";
import { request } from "node:https";
import { readFile } from "node:fs/promises";
import * as path from "#cli/core/path.js";
import { state } from "#cli/core/system.js";
import * as replica from "#cli/core/replica.js";

const defaults = [
  { name: "WEB1", role: "WEB", address: "http://127.0.0.1:5173" },
  { name: "WAS1", role: "WAS", address: "http://127.0.0.1:3000" },
  { name: "DB1", role: "DB", address: "" },
];

function object(value) {
  let invalid = !value;

  if (!invalid) {
    invalid = typeof value !== "object";
  }

  if (invalid) {
    return false;
  }

  const valid = !Array.isArray(value);

  return valid;
}

async function secure(address, route, option) {
  const { json, signal } = option;
  const ca = await readFile(path.certificate("ca", "crt"));

  const value = new Promise(function connect(resolve) {
    const target = new URL(route, address);

    const settings = {
      ca,
      rejectUnauthorized: true,
      timeout: 6000,
      family: 4,
      signal,
    };

    const input = request(target, settings, response);

    function response(output) {
      let text = "";

      output.on("error", function failure() {
        resolve(null);
      });

      output.on("data", function read(buffer) {
        text += buffer.toString();

        if (text.length > 65536) {
          input.destroy();
        }
      });

      output.on("end", function finish() {
        try {
          let result;

          if (json) {
            result = JSON.parse(text);
          } else {
            result = null;
          }

          let valid = json;

          if (valid) {
            valid = !object(result);
          }

          if (valid) {
            resolve(null);

            return;
          }

          let ok = output.statusCode >= 200;

          if (ok) {
            ok = output.statusCode < 300;
          }

          let report;

          if (json) {
            report = { ok, result };
          } else {
            report = { ok };
          }

          resolve(report);
        } catch {
          resolve(null);
        }
      });
    }

    input.on("timeout", function timeout() {
      input.destroy();
    });

    input.on("error", function failure() {
      resolve(null);
    });

    input.end();
  });

  return value;
}

async function read(address, route, option = {}) {
  const json = option.json ?? false;
  const started = performance.now();
  const timeout = AbortSignal.timeout(option.timeout ?? 6000);

  let signal;

  if (option.signal) {
    signal = AbortSignal.any([timeout, option.signal]);
  } else {
    signal = timeout;
  }

  try {
    let valid = path.system();

    if (valid) {
      valid = new URL(address).protocol === "https:";
    }

    if (valid) {
      const setting = { json, signal };
      const report = await secure(address, route, setting);

      if (report) {
        report.latency = performance.now() - started;
      }

      return report;
    }

    const target = new URL(route, address);
    const settings = { signal, redirect: "error" };
    const response = await fetch(target, settings);

    if (json) {
      const result = await response.json();

      if (!object(result)) {
        return null;
      }

      const ok = response.ok;
      const latency = performance.now() - started;
      const answer = { ok, result, latency };

      return answer;
    }

    await response.body?.cancel();

    const ok = response.ok;
    const latency = performance.now() - started;
    const outcome = { ok, latency };

    return outcome;
  } catch {
    return null;
  }
}

function reported(report, service, live) {
  let valid = !report.live;

  if (!valid) {
    valid = service.unit;
  }

  if (valid) {
    return false;
  }

  const pid = live.result.pid;

  let value = Number.isSafeInteger(pid);

  if (value) {
    value = pid > 0;
  }

  return value;
}

async function inspect(service, option) {
  const report = {
    ...service,
    pid: "",
    live: null,
    ready: null,
    database: "",
    state: "unknown",
  };

  let resolved = path.system();

  if (resolved) {
    resolved = service.unit;
  }

  if (resolved) {
    try {
      const status = await option.status;
      const entered = Date.parse(status.ActiveEnterTimestamp);
      const stopped = Date.parse(status.InactiveEnterTimestamp);
      const active = running(status);

      let known = active;

      if (known) {
        known = Number.isFinite(entered);
      }

      const duration = Math.max(0, (Date.now() - entered) / 1000);

      if (known) {
        report.uptime = duration;
      } else {
        report.uptime = null;
      }

      if (Number.isFinite(stopped)) {
        report.stopped = stopped;
      } else {
        report.stopped = null;
      }

      report.system = status.ActiveState;

      const pid = Number(status.MainPID);

      if (service.role !== "WEB") {
        if (pid > 0) {
          report.pid = pid;
        } else {
          report.pid = "";
        }
      }

      let operational;

      if (service.role === "DB") {
        operational = "unknown";
      } else {
        operational = "ready";
      }

      if (active) {
        report.state = operational;
      } else {
        report.state = "unavailable";
      }
    } catch {
      report.system = "unknown";
    }

    let valid = report.system !== "active";

    if (!valid) {
      valid = report.state === "unavailable";
    }

    if (valid) {
      report.state = "unavailable";
      report.live = false;
      report.ready = false;

      return report;
    }
  }

  if (option.gateway) {
    const status = await option.gateway;

    if (service.role === "WEB") {
      const pid = Number(status?.MainPID);
      const integer = Number.isSafeInteger(pid);
      const positive = pid > 0;
      const valid = integer && positive;

      if (valid) {
        report.pid = pid;
      } else {
        report.pid = "";
      }
    }

    if (!running(status)) {
      report.state = "unavailable";
      report.live = false;
      report.ready = false;

      return report;
    }
  }

  if (service.role === "WEB") {
    const response = await read(service.address, "", option);

    report.latency = response?.latency ?? null;
    report.live = response !== null;
    report.ready = response?.ok ?? false;
  } else if (service.role === "WAS") {
    const setting = { ...option, json: true };

    const requests = [
      read(service.address, "/live", setting),
      read(service.address, "/ready", setting),
    ];

    const [live, ready] = await Promise.all(requests);

    report.latency = ready?.latency ?? live?.latency ?? null;
    report.query = ready?.result.latency ?? null;

    if (!service.unit) {
      report.uptime = live?.result.uptime ?? null;
    }

    const liveness = live?.ok === true;

    let alive;

    if (liveness) {
      alive = live.result.live === true;
    }

    report.live = liveness && alive;

    const readiness = ready?.ok === true;

    let prepared;

    if (readiness) {
      prepared = ready.result.ready === true;
    }

    report.ready = readiness && prepared;

    const database = ready?.result.database;

    const recognized = [
      "ready",
      "unavailable",
      "unconfigured",
      "closed",
    ].includes(database);

    if (recognized) {
      report.database = database;
    } else {
      report.database = "unknown";
    }

    if (reported(report, service, live)) {
      report.pid = live.result.pid;
    }
  }

  if (["WEB", "WAS"].includes(service.role)) {
    if (report.ready) {
      report.state = "ready";
    } else {
      report.state = "unavailable";
    }

    let completion = service.unit;

    if (completion) {
      completion = report.system !== "active";
    }

    if (completion) {
      report.state = "unavailable";
    }
  }

  return report;
}

export function up(report) {
  if (report.state !== "ready") {
    return false;
  }

  if (report.role === "WAS") {
    let result = report.live === true;

    if (result) {
      result = report.ready === true;
    }

    return result;
  }

  return true;
}

function running(status) {
  let result = status?.ActiveState === "active";

  if (result) {
    result = status.SubState === "running";
  }

  return result;
}

async function inspectable(service, option) {
  let valid = !path.system();

  if (!valid) {
    valid = !service.unit;
  }

  if (valid) {
    return undefined;
  }

  try {
    return await state(service, option);
  } catch {
    return undefined;
  }
}

export async function health(manifest, option = {}) {
  const services = manifest?.services ?? defaults;
  const statuses = services.map((service) => inspectable(service, option));

  const gateway = services.findIndex((service) => {
    return service.role === "CADDY";
  });

  const reports = await Promise.all(
    services.map(function check(service, index) {
      const status = statuses[index];

      let proxy = path.system();

      if (proxy) {
        proxy = service.role === "WEB";
      }

      if (proxy) {
        proxy = gateway >= 0;
      }

      let dependency;

      if (proxy) {
        dependency = statuses[gateway];
      } else {
        dependency = undefined;
      }

      const setting = { ...option, status, gateway: dependency };

      return inspect(service, setting);
    }),
  );

  for (const report of reports) {
    if (manifest?.source?.commit) {
      report.commit = manifest.source.commit;
    }

    const service = services.find((value) => {
      return value.name === report.name;
    });

    const database = service?.role === "DB";
    const active = report.system === "active";
    const native = path.system();
    const inspectable = database && active && native;

    if (inspectable) {
      try {
        const replication = await replica.snapshot(manifest);

        report.replication = replication;

        if (replication.recovery) {
          report.mode = "replica";
        } else {
          report.mode = "primary";
        }

        if (!replication.recovery) {
          const source = reports.find((value) => {
            const was = value.role === "WAS";
            const connected = value.database === "ready";
            const valid = was && connected;

            return valid;
          });

          report.latency = source?.query ?? null;
        }

        const readonly = replication.readonly === "on";
        const streaming = replication.receiver?.status === "streaming";
        const standby = readonly && streaming;
        const writable = replication.readonly === "off";

        let ready;

        if (replication.recovery) {
          ready = standby;
        } else {
          ready = writable;
        }

        if (ready) {
          report.state = "ready";
        } else {
          report.state = "unavailable";
        }
      } catch {
        report.mode = null;
        report.state = "unavailable";
      }
    } else if (database) {
      report.mode = null;
    }
  }

  const count = reports.filter(function db(report) {
    return report.role === "DB";
  }).length;

  const databases = reports
    .filter(function was(report) {
      return report.role === "WAS";
    })
    .map(function state(report) {
      return report.database;
    });

  for (const report of reports) {
    if (path.system()) {
      continue;
    }

    let database = report.role === "DB";

    if (database) {
      database = count === 1;
    }

    let running = !report.unit;

    if (!running) {
      running = report.system === "active";
    }

    if (database && running) {
      const service = services.find((value) => {
        return value.name === report.name;
      });

      if (service?.mode === "replica") {
        continue;
      }

      const connected = databases.includes("ready");

      let state = "ready";

      if (!connected) {
        const database = databases[0];
        const fallback = "unknown";

        state = database || fallback;
      }

      report.database = state;
      report.state = state;

      const source = reports.find((value) => {
        let result = value.role === "WAS";

        if (result) {
          result = value.database === "ready";
        }

        return result;
      });

      report.latency = source?.query ?? null;
    }
  }

  return reports;
}

import * as fs from "node:fs/promises";
import * as https from "node:https";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import { performance } from "node:perf_hooks";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as health from "#cli/core/health.js";
import * as archive from "#cli/core/record.js";
import * as monitor from "#cli/core/monitor.js";
import * as logs from "#cli/core/archive.js";
import * as retention from "#cli/core/retention.js";
import { setTimeout as delay } from "node:timers/promises";
import { internal } from "#cli/network/config.js";

export const filename = path.child(path.home, "cluster.json");

export const timeout = 4000;

const limit = 4194304;
const roles = ["WAS", "WEB", "DB"];

export async function config() {
  let details;

  try {
    details = await fs.lstat(filename);
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  }

  const owner = store.secure(details);
  const restricted = (details.mode & 0o077) === 0;
  const secure = owner && restricted;

  if (!secure) {
    throw new Error("CLUSTER_OWNER: Invalid cluster configuration owner.");
  }

  const text = await fs.readFile(filename, "utf8");
  const settings = JSON.parse(text);
  const version = settings.version === 1;
  const token = typeof settings.token === "string";
  const nodes = Array.isArray(settings.nodes);
  const valid = version && token && nodes;

  if (!valid) {
    throw new Error("CLUSTER_CONFIG: Invalid cluster configuration.");
  }

  if (settings.token.length < 32) {
    throw new Error("CLUSTER_TOKEN: Invalid cluster access token.");
  }

  const names = new Set();
  const identifiers = new Set();

  for (const node of settings.nodes) {
    let network = isIPv4(node.address);

    if (network) {
      network = internal(node.address);
    }

    const integer = Number.isSafeInteger(node.port);
    const range = node.port > 0;
    const maximum = node.port <= 65535;
    const port = integer && range && maximum;
    const id = typeof node.id === "string";
    const services = Array.isArray(node.services);
    const valid = network && port && id && services;

    if (!valid) {
      throw new Error("CLUSTER_NODE: Invalid private node endpoint.");
    }

    if (identifiers.has(node.id)) {
      throw new Error("CLUSTER_DUPLICATE: Duplicate node identity.");
    }

    identifiers.add(node.id);

    for (const service of node.services) {
      const role = roles.includes(service.role);
      const name = new RegExp(`^${service.role}[1-9]\\d*$`).test(service.name);
      const unique = !names.has(service.name);
      const valid = role && name && unique;

      if (!valid) {
        throw new Error("CLUSTER_SERVICE: Invalid service identity.");
      }

      names.add(service.name);
    }
  }

  if (!identifiers.has(settings.local)) {
    throw new Error("CLUSTER_LOCAL: Local node is not registered.");
  }

  return settings;
}

function host(report, node, local) {
  const service = {
    ...report,
    host: { id: node.id, address: node.address, local },
  };

  if (report.role === "EXTERNAL") {
    return service;
  }

  if (report.address) {
    if (report.role === "DB") {
      const port = report.address.split(":").at(-1);

      service.address = node.address + ":" + port;
    } else {
      const address = new URL(report.address);

      address.hostname = node.address;
      service.address = address.origin;
    }
  }

  return service;
}

function observed(services, value, option = {}) {
  const age = (option.time ?? Date.now()) - (value?.time ?? 0);
  const recent = age >= 0;
  const timely = age <= monitor.policy.interval * 4;
  const fresh = recent && timely;
  const sample = { source: value?.source, time: value?.time };

  return services.map((service) => {
    const saved = value?.reports.find((report) => report.name === service.name);

    if (fresh && saved) {
      return { ...saved, sample };
    }

    let last;

    if (saved?.state === "unknown") {
      last = saved.last;
    } else {
      last = saved;
    }

    const report = {
      name: service.name,
      role: service.role,
      unit: service.unit,
      address: service.address,
      port: service.port,
      state: "unknown",
      system: "unknown",
      pid: "",
      mode: null,
      resource: null,
      sample,
      last: last,
      seen: value?.time ?? null,
      checked: option.time ?? Date.now(),
    };

    return report;
  });
}

function retained(reports, entries) {
  for (const report of reports) {
    if (report.resource != null) {
      continue;
    }

    if (report.state === "unknown") {
      continue;
    }

    const entry = entries.find(([name]) => name === report.name)?.[1];

    const previous = entry?.timeline?.findLast((sample) => {
      const earlier = sample.time < report.sample.time;
      const measured = sample.resource != null;
      const available = earlier && measured;

      return available;
    });

    if (previous) {
      report.last = { resource: previous.resource };
      report.seen = previous.time;
    }
  }
}

export async function snapshot(manifest, option = {}) {
  const supplied = Object.hasOwn(option, "config");

  let settings;

  if (supplied) {
    settings = option.config;
  } else {
    settings = await config();
  }

  const node = settings?.nodes.find((node) => {
    return node.id === settings.local;
  });

  let reports;
  let history;

  if (option.viewer) {
    history = await archive.latest({
      stale: true,
      time: option.time,
      restore: option.history !== false,
    });

    const services = new Map(
      manifest.services.map((service) => [service.name, service]),
    );

    for (const report of history?.reports ?? []) {
      if (!services.has(report.name)) {
        services.set(report.name, { name: report.name, role: report.role });
      }
    }

    reports = observed([...services.values()], history, option);

    retained(reports, history?.entries ?? []);
  } else {
    [reports, history] = await Promise.all([
      health.health(manifest, option),
      archive.latest({ stale: true, restore: option.history !== false }),
    ]);
  }

  for (const report of reports) {
    if (option.viewer) {
      continue;
    }

    const previous = history?.reports.find((value) => {
      return value.name === report.name;
    });

    const age = Date.now() - (history?.time ?? 0);
    const fresh = age <= monitor.policy.interval * 4;
    const same = previous?.pid === report.pid;
    const valid = fresh && same;

    if (valid) {
      report.resource = previous.resource;
    }
  }

  let values = reports;

  if (node) {
    const names = new Set(node.services.map((service) => service.name));

    values = reports
      .filter((report) => {
        const instance = roles.includes(report.role);
        const selected = names.has(report.name);
        const supporting = !instance;
        const included = supporting || selected;

        return included;
      })
      .map((report) => host(report, node, true));
  }

  const entries = history?.entries ?? [];
  const source = history?.source;

  const result = {
    version: 1,
    source,
    time: Date.now(),
    reports: values,
    entries,
  };

  if (option.viewer) {
    result.sample = { source, time: history?.time };
  }

  if (option.history) {
    const names = new Set(node.services.map((service) => service.name));
    const records = await logs.read({ from: option.since });
    const since = option.since ?? 0;

    result.history = records
      .filter((entry) => entry.source === result.source)
      .filter((entry) => entry.time > since)
      .slice(0, retention.page)
      .map((entry) => {
        const result = {
          ...entry,
          samples: entry.samples.filter((sample) => names.has(sample.name)),
        };

        return result;
      });
  }

  return result;
}

export async function remote(node, settings, option = {}) {
  const ca = await fs.readFile(path.certificate("ca", "crt"));
  const timer = AbortSignal.timeout(option.timeout ?? timeout);

  let signal;

  if (option.signal) {
    signal = AbortSignal.any([timer, option.signal]);
  } else {
    signal = timer;
  }

  const address = new URL(`https://${node.address}:${node.port}/snapshot`);

  if (option.viewer) {
    address.searchParams.set("viewer", "1");
  }

  if (option.history) {
    address.searchParams.set(
      "since",
      String(option.since ?? Date.now() - monitor.policy.retention),
    );
  }

  const headers = { Authorization: "Bearer " + settings.token };

  const result = new Promise((resolve, reject) => {
    const request = https.get(
      address,
      { ca, headers, signal, rejectUnauthorized: true },
      (response) => {
        const buffers = [];

        let size = 0;

        response.on("data", (buffer) => {
          size += buffer.length;

          if (size > limit) {
            request.destroy(
              new Error("CLUSTER_LIMIT: Snapshot exceeds the size limit."),
            );

            return;
          }

          buffers.push(buffer);
        });

        response.on("error", reject);

        response.on("end", () => {
          try {
            if (response.statusCode !== 200) {
              throw new Error("CLUSTER_RESPONSE: Snapshot request failed.");
            }

            const text = Buffer.concat(buffers).toString("utf8");
            const snapshot = JSON.parse(text);
            const recent = Math.abs(Date.now() - snapshot.time) <= timeout * 3;
            const reports = Array.isArray(snapshot.reports);
            const entries = Array.isArray(snapshot.entries);
            const valid = recent && reports && entries;

            if (!valid) {
              throw new Error("CLUSTER_SNAPSHOT: Invalid or expired snapshot.");
            }

            const missing = !snapshot.sample;
            const viewer = option.viewer === true;
            const unavailable = viewer && missing;

            if (unavailable) {
              throw new Error("CLUSTER_SAMPLE: Monitor sample is unavailable.");
            }

            for (const service of node.services) {
              const report = snapshot.reports.find((report) => {
                return report.name === service.name;
              });

              const role = report?.role === service.role;
              const identity = report?.host?.id === node.id;
              const valid = role && identity;

              if (!valid) {
                throw new Error(
                  "CLUSTER_IDENTITY: Remote service identity does not match.",
                );
              }
            }

            if (snapshot.history) {
              const bounded = Array.isArray(snapshot.history);
              const count = snapshot.history.length <= retention.page;
              const valid = bounded && count;

              if (!valid) {
                throw new Error("CLUSTER_HISTORY: Invalid history page.");
              }

              for (const entry of snapshot.history) {
                const time = Number.isFinite(entry.time);
                const identity = entry.source === snapshot.source;
                const samples = Array.isArray(entry.samples);
                const valid = time && identity && samples;

                if (!valid) {
                  throw new Error("CLUSTER_HISTORY: Invalid history sample.");
                }
              }
            }

            resolve(snapshot);
          } catch (failure) {
            reject(failure);
          }
        });
      },
    );

    request.on("error", reject);
  });

  return result;
}

export async function collect(manifest, option = {}) {
  let settings;

  try {
    settings = option.config ?? (await config());
  } catch {
    settings = null;
  }

  const local = snapshot(manifest, { ...option, config: settings });
  const configured = settings?.nodes ?? [];

  const nodes = configured.filter((node) => {
    return node.id !== settings.local;
  });

  const others = nodes.map(async (node) => {
    try {
      const duration = option.remote ?? timeout;

      let history;

      if (option.viewer) {
        history = false;
      } else {
        history = option.history;
      }

      const started = performance.now();
      const value = await remote(node, settings, {
        ...option,
        history: history,
        timeout: duration,
      });

      if (option.viewer) {
        const elapsed = performance.now() - started;
        const time = value.time + elapsed;

        value.reports = observed(
          node.services,
          { ...value, source: value.sample.source, time: value.sample.time },
          { ...option, time },
        );
      }

      const reports = node.services.map((service) => {
        const report = value.reports.find((report) => {
          return report.name === service.name;
        });

        return host(report, node, false);
      });

      const result = { ...value, reports };

      try {
        if (!option.viewer) {
          await retention.save(node, result, option);
        }

        const preserved = await retention.read(node, {
          ...option,
          restore: option.history !== false,
        });

        if (preserved?.source === result.source) {
          result.entries = preserved.entries;
        }

        if (option.viewer) {
          retained(result.reports, result.entries);
        }
      } catch {
        result.preserved = false;
      }

      return result;
    } catch {
      const previous = await retention.read(node, {
        ...option,
        restore: option.history !== false,
      });

      const reports = node.services.map((service) =>
        host(
          {
            ...service,
            pid: "",
            mode: null,
            state: "unknown",
            system: "unknown",
            resource: null,
            last: previous?.reports.find(
              (report) => report.name === service.name,
            ),
            seen: previous?.sample?.time ?? previous?.time ?? null,
            checked: Date.now(),
          },
          node,
          false,
        ),
      );

      const entries = previous?.entries ?? [];
      const output = { reports, entries };

      return output;
    }
  });

  const values = await Promise.all([local, ...others]);
  const reports = values.flatMap((value) => value.reports);
  const entries = values.flatMap((value) => value.entries);
  const value = { version: 1, time: Date.now(), reports, entries };

  return value;
}

export async function view(manifest, option = {}) {
  return collect(manifest, { history: false, ...option, viewer: true });
}

export async function open(manifest, option = {}) {
  const settings = option.config ?? (await config());

  if (!settings) {
    return null;
  }

  const node = settings.nodes.find((node) => {
    return node.id === settings.local;
  });

  const certificate = settings.certificate ?? "db";

  const [key, cert] = await Promise.all([
    fs.readFile(path.certificate(certificate, "key")),
    fs.readFile(path.certificate(certificate, "crt")),
  ]);

  const expected = Buffer.from("Bearer " + settings.token);
  const allowed = new Set(settings.nodes.map((node) => node.address));

  const server = https.createServer(
    { key, cert },
    async (request, response) => {
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
      const listed = allowed.has(address);
      const loopback = address === "127.0.0.1";
      const network = listed || loopback;
      const actual = Buffer.from(request.headers.authorization ?? "");
      const length = actual.length === expected.length;

      let token = false;

      if (length) {
        token = timingSafeEqual(actual, expected);
      }

      const authorized = network && token;

      response.setHeader("Cache-Control", "no-store");

      if (!authorized) {
        response.writeHead(403).end();

        return;
      }

      const method = request.method === "GET";
      const url = new URL(request.url, "https://localhost");
      const route = url.pathname === "/snapshot";
      const supported = method && route;

      if (!supported) {
        response.writeHead(404).end();

        return;
      }

      try {
        const history = url.searchParams.has("since");
        const since = Number(url.searchParams.get("since"));
        const finite = Number.isFinite(since);
        const positive = since >= 0;
        const valid = finite && positive;
        const refused = !valid;
        const invalid = history && refused;

        if (invalid) {
          response.writeHead(400).end();

          return;
        }

        const value = await snapshot(manifest, {
          config: settings,
          timeout: 1500,
          history,
          since,
          viewer: url.searchParams.get("viewer") === "1",
        });

        const roles = new Set(node.services.map((service) => service.name));

        value.reports = value.reports.filter((report) =>
          roles.has(report.name),
        );
        value.entries = value.entries.filter(([name]) => roles.has(name));

        response.setHeader("Content-Type", "application/json");

        response.end(JSON.stringify(retention.project(value, node)));
      } catch {
        response.writeHead(503).end();
      }
    },
  );

  server.requestTimeout = timeout;
  server.headersTimeout = timeout;

  await new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(node.port, "0.0.0.0", resolve);
  });

  function close() {
    server.close();

    server.closeAllConnections();
  }

  option.signal?.addEventListener("abort", close, { once: true });

  return server;
}

export async function follow(option = {}) {
  while (!option.signal?.aborted) {
    const started = Date.now();

    try {
      const settings = option.config ?? (await config());

      const nodes =
        settings?.nodes.filter((node) => node.id !== settings.local) ?? [];

      await Promise.allSettled(
        nodes.map(async (node) => {
          const previous = await retention.read(node, {
            ...option,
            restore: false,
          });

          const value = await remote(node, settings, {
            ...option,
            history: true,
            since: previous?.cursor,
            viewer: true,
          });

          await retention.save(node, value, option);
        }),
      );
    } catch {
      if (option.signal?.aborted) {
        return;
      }
    }

    const elapsed = Date.now() - started;

    try {
      await delay(
        Math.max(0, monitor.policy.interval - elapsed),
        undefined,
        option,
      );
    } catch {
      if (!option.signal?.aborted) {
        throw new Error("CLUSTER_HISTORY: History sampling delay failed.");
      }
    }
  }
}

import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as path from "#cli/core/path.js";
import * as record from "#cli/core/record.js";
import * as archive from "#cli/core/archive.js";
import * as monitor from "#cli/core/monitor.js";
import * as health from "#cli/core/health.js";
import { hold } from "#cli/core/lock.js";

export const page = 120;

const cache = new Map();

function pick(value, names) {
  const entries = names.filter((name) => Object.hasOwn(value ?? {}, name));

  return Object.fromEntries(entries.map((name) => [name, value[name]]));
}

function resource(value) {
  if (value == null) {
    return null;
  }

  return pick(value, [
    "cpu",
    "processors",
    "memory",
    "resident",
    "ram",
    "disk",
    "used",
    "total",
    "free",
    "scope",
    "rss",
  ]);
}

function replication(value) {
  const result = pick(value, [
    "cluster",
    "timeline",
    "recovery",
    "readonly",
    "position",
    "received",
    "replayed",
    "lag",
    "replay",
    "paused",
    "time",
    "sessions",
    "prepared",
  ]);

  if (value?.receiver) {
    result.receiver = pick(value.receiver, [
      "status",
      "sender_host",
      "sender_port",
      "received_tli",
      "flushed_lsn",
      "last_msg_receipt_time",
    ]);
  } else {
    result.receiver = null;
  }

  return result;
}

function report(value) {
  const result = pick(value, [
    "name",
    "role",
    "pid",
    "mode",
    "state",
    "system",
    "address",
    "port",
    "live",
    "ready",
    "database",
    "commit",
    "uptime",
    "latency",
    "stopped",
  ]);

  result.resource = resource(value.resource);
  result.sample = pick(value.sample, ["source", "time"]);
  result.seen = value.seen;

  if (value.last) {
    result.last = report({ ...value.last, last: undefined });
  }

  result.host = pick(value.host, ["id", "address", "local"]);

  if (value.replication) {
    result.replication = replication(value.replication);
  }

  return result;
}

function event(value) {
  return pick(value, [
    "id",
    "time",
    "name",
    "check",
    "value",
    "level",
    "source",
    "summary",
    "command",
  ]);
}

export function project(value, node) {
  const names = new Set(node.services.map((service) => service.name));

  const reports = value.reports
    .filter((value) => names.has(value.name))
    .map(report);

  const entries = value.entries
    .filter(([name]) => names.has(name))
    .map(([name, entry]) => [
      name,
      {
        previous: (entry.previous ?? []).map(([key, value]) => [
          key,
          event(value),
        ]),
        up: entry.up,
        down: entry.down,
        events: (entry.events ?? []).map(event),
        timeline: (entry.timeline ?? []).map((sample) => {
          const result = {
            ...pick(sample, ["id", "time", "state", "latency", "source"]),
            resource: resource(sample.resource),
            events: sample.events ?? [],
          };

          return result;
        }),
      },
    ]);

  const history = (value.history ?? []).map((entry) => {
    const result = {
      source: entry.source,
      time: entry.time,
      samples: entry.samples
        .filter((sample) => names.has(sample.name))
        .map((sample) => {
          const result = {
            ...pick(sample, [
              "name",
              "id",
              "time",
              "state",
              "latency",
              "pid",
              "commit",
              "mode",
              "up",
            ]),
            resource: resource(sample.resource),
            replication: replication(sample.replication),
            events: (sample.events ?? []).map(event),
          };

          return result;
        }),
    };

    return result;
  });

  return {
    version: 1,
    source: value.source,
    time: value.time,
    sample: value.sample,
    reports,
    entries,
    history,
  };
}

function directory(node, option) {
  const identity = JSON.stringify([
    node.id,
    node.address,
    node.port,
    node.services,
  ]);

  const name = createHash("sha256").update(identity).digest("hex");

  return path.child(
    option.directory ?? path.child(path.history, "remote"),
    name,
  );
}

async function secure(directory) {
  const details = await fs.lstat(directory);
  const folder = details.isDirectory();
  const owner = details.uid === process.getuid?.();
  const restricted = !(details.mode & 0o077);
  const valid = folder && owner && restricted;

  if (!valid) {
    throw new Error("HISTORY_OWNER: Unsafe remote history directory.");
  }
}

export async function read(node, option = {}) {
  try {
    const root = directory(node, option);

    await secure(path.parent(root));

    await secure(root);

    const details = await fs.lstat(path.child(root, "state.json"));
    const file = details.isFile();
    const owner = details.uid === process.getuid?.();
    const restricted = !(details.mode & 0o077);
    const valid = file && owner && restricted;

    if (!valid) {
      return null;
    }

    return await record.latest({
      directory: root,
      history: root,
      stale: true,
      time: option.time,
      restore: option.restore,
    });
  } catch {
    return null;
  }
}

async function stamp(root) {
  try {
    const file = await fs.lstat(path.child(root, "state.json"));
    const result = [
      file.dev,
      file.ino,
      file.size,
      file.mtimeMs,
      file.ctimeMs,
    ].join(":");

    return result;
  } catch (failure) {
    if (failure.code !== "ENOENT") {
      throw failure;
    }

    return null;
  }
}

async function index(root, time) {
  const identity = await stamp(root);
  const saved = cache.get(root);
  const matching = saved?.stamp === identity;

  if (saved && matching) {
    return new Map(saved.known);
  }

  const records = await archive.read({ directory: root, time });
  const known = new Map(
    records.map((entry) => [`${entry.source}:${entry.time}`, entry.time]),
  );

  return known;
}

export async function save(node, value, option = {}) {
  const root = directory(node, option);
  const parent = path.parent(root);

  await secure(path.parent(parent));

  await fs.mkdir(parent, { recursive: true, mode: 0o700 });

  await secure(parent);

  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  await secure(root);

  const release = await hold(path.child(root, "history.lock"));
  const temporary = path.child(root, ".state-" + randomUUID());

  try {
    const previous = await read(node, { ...option, restore: false });
    const now = option.time ?? Date.now();
    const cutoff = now - monitor.policy.retention;
    const stored = project(value, node);
    const known = await index(root, now);

    for (const [key, time] of known) {
      if (time < cutoff) {
        known.delete(key);
      }
    }

    for (const entry of stored.history) {
      const key = `${entry.source}:${entry.time}`;
      const recent = entry.time >= cutoff;
      const absent = !known.has(key);
      const append = recent && absent;

      if (append) {
        await archive.append(entry, { directory: root });

        known.set(key, entry.time);
      }
    }

    const events = new Map(
      stored.entries
        .flatMap(([, entry]) => entry.events)
        .map((event) => [event.id, event]),
    );

    for (const [, entry] of stored.entries) {
      for (const sample of entry.timeline) {
        const key = `${stored.source}:${sample.time}`;
        const absent = !known.has(key);
        const recent = sample.time >= cutoff;
        const append = absent && recent;

        if (append) {
          const samples = stored.entries.flatMap(([name, entry]) =>
            entry.timeline
              .filter((item) => item.time === sample.time)
              .map((item) => {
                const result = {
                  name,
                  ...item,
                  events: item.events
                    .map((id) => events.get(id))
                    .filter(Boolean),
                };

                return result;
              }),
          );

          await archive.append(
            { source: stored.source, time: sample.time, samples },
            { directory: root },
          );

          known.set(key, sample.time);
        }
      }
    }

    const older = previous?.time > stored.time;

    if (older) {
      return;
    }

    for (const report of stored.reports) {
      const before = previous?.reports.find(
        (entry) => entry.name === report.name,
      );

      if (health.up(report)) {
        report.healthy = stored.time;
      } else {
        report.healthy = before?.healthy ?? null;
      }
    }

    const cursor = Math.max(
      previous?.cursor ?? cutoff,
      ...stored.history.map((entry) => entry.time),
    );

    const prune = now - (previous?.cleaned ?? 0) >= 60000;

    let cleaned;

    if (prune) {
      cleaned = now;
    } else {
      cleaned = previous.cleaned;
    }

    const state = { ...stored, history: undefined, cursor, cleaned };
    const file = await fs.open(temporary, "wx", 0o600);

    try {
      await file.writeFile(JSON.stringify(state) + "\n");

      await file.sync();
    } finally {
      await file.close();
    }

    await fs.rename(temporary, path.child(root, "state.json"));

    const directory = await fs.open(root, "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }

    if (prune) {
      await archive.prune(now, { directory: root });
    }

    const identity = await stamp(root);

    cache.set(root, { stamp: identity, known });
  } finally {
    try {
      await fs.unlink(temporary).catch((failure) => {
        if (failure.code !== "ENOENT") {
          throw failure;
        }
      });
    } finally {
      await release();
    }
  }
}

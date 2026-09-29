import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as health from "#cli/core/health.js";
import * as support from "#cli/core/support.js";
import * as resource from "#cli/core/resource.js";
import * as monitor from "#cli/core/monitor.js";
import * as archive from "#cli/core/archive.js";
import * as intent from "#cli/core/intent.js";
import * as template from "#cli/core/template.js";
import { error } from "#cli/core/error.js";

const limit = archive.limit;

function filenames(directory) {
  const state = path.child(directory, "state.json");
  const temporary = path.child(directory, "state.tmp");
  const result = { state, temporary };

  return result;
}

async function regular(filename) {
  const details = await fs.lstat(filename);

  let unsafe = !details.isFile();

  if (!unsafe) {
    unsafe = details.isSymbolicLink();
  }

  if (unsafe) {
    throw error("monitoring");
  }

  return details;
}

function event(value) {
  let invalid = !value;

  if (!invalid) {
    invalid = typeof value !== "object";
  }

  if (invalid) {
    return false;
  }

  let identity = typeof value.id === "string";

  if (identity) {
    identity = value.id.length > 0;
  }

  const time = Number.isFinite(value.time);
  const level = ["info", "success", "warning", "error"].includes(value.level);

  let result = identity && time && level;

  if (result) {
    result = observation(value);
  }

  return result;
}

function observation(value) {
  let invalid = !value;

  if (!invalid) {
    invalid = typeof value !== "object";
  }

  if (invalid) {
    return false;
  }

  const name = typeof value.name === "string";
  const check = typeof value.check === "string";
  const state = ["string", "boolean"].includes(typeof value.value);
  const result = name && check && state;

  return result;
}

function report(value) {
  let invalid = !value;

  if (!invalid) {
    invalid = typeof value !== "object";
  }

  if (invalid) {
    return false;
  }

  let name = typeof value.name === "string";

  if (name) {
    name = value.name.length > 0;
  }

  const role = ["WAS", "WEB", "DB", "CADDY", "EXTERNAL"].includes(value.role);
  const result = name && role;

  return result;
}

function previous(value) {
  let answer = !Array.isArray(value);

  if (!answer) {
    answer = value.length !== 2;
  }

  if (answer) {
    return false;
  }

  const [key, check] = value;

  let result = typeof key === "string";

  if (result) {
    result = observation(check);
  }

  if (result) {
    result = key === check.check;
  }

  return result;
}

function header(value) {
  let valid = !value;

  if (!valid) {
    valid = value.version !== 1;
  }

  if (valid) {
    return false;
  }

  const time = Number.isFinite(value.time);
  const reports = Array.isArray(value.reports);
  const entries = Array.isArray(value.entries);
  const result = time && reports && entries;

  return result;
}

function sample(value) {
  let invalid = !value;

  if (!invalid) {
    invalid = typeof value !== "object";
  }

  if (invalid) {
    return false;
  }

  const identity = typeof value.id === "string";
  const time = Number.isFinite(value.time);
  const state = [".", "+", "!", "x"].includes(value.state);
  const events = Array.isArray(value.events);
  const result = identity && time && state && events;

  return result;
}

function entry(value) {
  let valid = !Array.isArray(value);

  if (!valid) {
    valid = value.length !== 2;
  }

  if (valid) {
    return false;
  }

  const [name, record] = value;

  let response = typeof name !== "string";

  if (!response) {
    response = !record;
  }

  if (response) {
    return false;
  }

  return Array.isArray(record.previous);
}

async function read(directory = path.monitoring, option = {}) {
  const filename = filenames(directory).state;
  const details = await regular(filename);

  if (details.size > limit) {
    throw error("monitoring");
  }

  const content = await fs.readFile(filename, "utf8");
  const snapshot = JSON.parse(content);

  if (!header(snapshot)) {
    throw error("monitoring");
  }

  if (option.restore === false) {
    snapshot.entries = snapshot.entries.filter(entry);
    snapshot.reports = snapshot.reports.filter(report);

    return snapshot;
  }

  const records = await archive.read({
    directory: option.history,
    time: option.time,
  });

  const from = (option.time ?? Date.now()) - monitor.policy.retention;

  snapshot.entries = snapshot.entries.filter(entry).map(function recover(pair) {
    const [name, entry] = pair;

    const samples = records
      .filter((record) => {
        return record.source === snapshot.source;
      })
      .flatMap((record) =>
        record.samples
          .filter((value) => {
            let result = sample(value);

            if (result) {
              result = value.name === name;
            }

            return result;
          })
          .map((sample) => {
            const result = { ...sample, source: record.source };

            return result;
          }),
      );

    const logs = samples.flatMap((sample) => {
      const result = sample.events ?? [];

      return result;
    });

    const retained = [...(entry.events ?? []), ...logs];

    const emitted = retained.filter((value) => {
      let result = event(value);

      if (result) {
        result = value.time > from;
      }

      return result;
    });

    const events = [
      ...new Map(emitted.map((value) => [value.id, value])).values(),
    ].sort((first, second) => {
      const result = first.time - second.time;

      return result;
    });

    const timeline = samples
      .filter((value) => {
        let result = sample(value);

        if (result) {
          result = value.time > from;
        }

        return result;
      })
      .slice(-monitor.policy.samples)
      .map((value) => {
        const result = {
          ...value,
          events: value.events.filter(event).map((event) => event.id),
        };

        return result;
      });

    const checks = entry.previous.filter(previous);
    const states = timeline.map((sample) => sample.state);

    const latency = timeline.map((sample) => {
      const result = sample.latency ?? null;

      return result;
    });

    const restored = {
      ...entry,
      events,
      timeline,
      previous: checks,
      states,
      samples: latency,
    };

    const output = [name, restored];

    return output;
  });
  snapshot.reports = snapshot.reports.filter(report);

  return snapshot;
}

export async function latest(option = {}) {
  try {
    const value = await read(option.directory, option);
    const age = (option.time ?? Date.now()) - value.time;

    let valid = !option.stale;

    if (valid) {
      valid = age > monitor.policy.interval * 4;
    }

    if (valid) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

export async function history(name, option = {}) {
  const records = await archive.read(option);

  const output = records.flatMap((record) =>
    record.samples
      .filter((value) => {
        let result = sample(value);

        if (result) {
          result = value.name === name;
        }

        return result;
      })
      .map((value) => {
        const result = { ...value, source: record.source };

        return result;
      }),
  );

  return output;
}

export async function register(manifest, executable) {
  const directories = [path.log, path.monitoring, path.history];

  for (const directory of directories) {
    const data = directory !== path.log;
    const setting = { data, keep: false, mode: 0o700 };

    if (!(await store.exists(directory))) {
      const entry = store.entry(manifest, directory);

      if (entry) {
        await fs.mkdir(directory, { mode: setting.mode });

        entry.done = true;

        await store.write(manifest);
      } else {
        await store.directory(manifest, directory, setting);
      }
    } else {
      const details = await fs.lstat(directory);
      const entry = store.entry(manifest, directory);

      let response = !entry;

      if (!response) {
        response = !store.folder(details);
      }

      if (!response) {
        response = details.uid !== 0;
      }

      if (response) {
        throw error("changed");
      }
    }
  }

  const unit = "orbit-monitor.service";
  const filename = path.unit(unit);

  const previous = await fs.readFile(filename, "utf8").catch((failure) => {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  });

  const generated = template.observer(executable);
  const contents = template.preserve(generated, previous);

  if (!(await store.exists(filename))) {
    const entry = store.entry(manifest, filename);

    if (entry) {
      const mode = entry.mode ?? 0o644;
      const setting = { flag: "wx", mode };

      await fs.writeFile(filename, contents, setting);

      entry.hash = await store.digest(filename);
      entry.done = true;

      await store.write(manifest);
    } else {
      await store.file(manifest, filename, contents);
    }
  } else {
    const previous = await fs.readFile(filename, "utf8");

    if (previous !== contents) {
      const entry = store.entry(manifest, filename);

      let resolved = !entry;

      if (!resolved) {
        resolved = (await store.digest(filename)) !== entry.hash;
      }

      if (resolved) {
        throw error("changed");
      }

      const temporary = path.adjacent(filename, ".monitor-unit.tmp");
      const file = await fs.open(temporary, "wx", entry.mode ?? 0o644);

      try {
        try {
          await file.writeFile(contents);
        } finally {
          await file.close();
        }

        await fs.rename(temporary, filename);
      } finally {
        await fs.unlink(temporary).catch((failure) => {
          if (failure.code !== "ENOENT") {
            throw failure;
          }
        });
      }

      entry.hash = await store.digest(filename);

      await store.write(manifest);
    }
  }

  const entry = { name: "Monitor", role: "MONITOR", unit };

  if (
    !manifest.services.some((service) => {
      return service.role === "MONITOR";
    })
  ) {
    manifest.services.push(entry);
  }

  await store.write(manifest);
}

async function save(directory, value) {
  const files = filenames(directory);
  const contents = JSON.stringify(value) + "\n";
  const write = fs.constants.O_WRONLY;
  const create = fs.constants.O_CREAT;
  const truncate = fs.constants.O_TRUNC;
  const follow = fs.constants.O_NOFOLLOW;
  const flags = write | create | truncate | follow;
  const file = await fs.open(files.temporary, flags, 0o600);

  try {
    try {
      await file.writeFile(contents);

      await file.sync();
    } finally {
      await file.close();
    }

    await fs.rename(files.temporary, files.state);
  } finally {
    await fs.unlink(files.temporary).catch((failure) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function run(manifest, option = {}) {
  const directory = option.directory ?? path.monitoring;
  const details = await fs.lstat(directory);

  let output = !details.isDirectory();

  if (!output) {
    output = details.isSymbolicLink();
  }

  if (output) {
    throw error("monitoring");
  }

  const order = (values) => values;
  const record = monitor.session({ order });
  const resources = resource.session();
  const machine = await fs.readFile(path.machine, "utf8");

  const source = crypto
    .createHash("sha256")
    .update(machine.trim())
    .digest("hex");

  try {
    const previous = await read(directory, option);

    if (previous.source === source) {
      record.load(previous);
    }
  } catch (failure) {
    let recoverable = failure.code === "ENOENT";

    if (!recoverable) {
      recoverable = failure.code === "monitoring";
    }

    if (!recoverable) {
      recoverable = failure instanceof SyntaxError;
    }

    if (!recoverable) {
      throw failure;
    }
  }

  const history = option.history ?? path.history;
  const storage = { directory: history };

  let cleaned = 0;

  while (!option.signal?.aborted) {
    const started = Date.now();
    const setting = { signal: option.signal };

    const values = await Promise.all([
      health.health(manifest, setting),
      support.external(setting),
    ]);

    const [local, external] = values;

    if (option.signal?.aborted) {
      return;
    }

    const caddy = local.find((report) => {
      return report.role === "CADDY";
    });

    const web = local.find((report) => {
      return report.role === "WEB";
    });

    if (caddy) {
      caddy.latency = web?.latency;
    }

    await Promise.all(
      monitor.order(local).map(async function measure(report) {
        report.resource = await resources.read(report, setting);
      }),
    );

    if (option.signal?.aborted) {
      return;
    }

    const reports = [
      ...local.filter((report) => {
        return report.role !== "MONITOR";
      }),
      ...external,
    ];

    const time = Date.now();
    const expected = await intent.read();
    const observation = { time, source, intent: expected, started };

    record.record(reports, observation);

    const state = record.dump();

    const samples = state.entries.map(function sample([name, entry]) {
      const value = entry.timeline.at(-1);

      const events = entry.events.filter((event) =>
        value.events.includes(event.id),
      );

      const result = { name, ...value, events };

      return result;
    });

    const entries = state.entries.map(([name, entry]) => {
      const previous = entry.previous;
      const up = entry.up;
      const down = entry.down;
      const handled = entry.handled;
      const settled = entry.settled;
      const failed = entry.failed;
      const result = [name, { previous, up, down, handled, settled, failed }];

      return result;
    });

    const latest = reports.map((report) => {
      const { events, ...value } = report;

      void events;

      return value;
    });

    const value = { version: 1, source, time, reports: latest, entries };
    const history = { source, time, samples };

    await archive.append(history, storage);

    await save(directory, value);

    if (time - cleaned >= 60000) {
      await archive.prune(time, storage);

      cleaned = time;
    }

    const elapsed = Date.now() - started;

    await delay(
      Math.max(0, monitor.policy.interval - elapsed),
      undefined,
      setting,
    );
  }
}

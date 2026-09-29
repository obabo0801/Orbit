import * as health from "#cli/core/health.js";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import * as resource from "#cli/core/resource.js";

export const policy = { interval: 5000, retention: 86400000, samples: 60 };

export function order(reports) {
  const roles = ["WAS", "WEB", "DB"];
  const numeric = { numeric: true };

  const value = reports
    .filter((report) => roles.includes(report.role))
    .sort(function compare(first, second) {
      const role = roles.indexOf(first.role) - roles.indexOf(second.role);
      const name = first.name.localeCompare(second.name, undefined, numeric);
      const result = role || name;

      return result;
    });

  return value;
}

export function session(option = {}) {
  const history = new Map();

  let reports = [];

  function record(values, setting = {}) {
    if (option.order) {
      reports = option.order(values);
    } else {
      reports = order(values);
    }

    const time = setting.time ?? Date.now();

    for (const report of reports) {
      let entry = history.get(report.name);

      if (!entry) {
        const previous = new Map();

        entry = {
          samples: [],
          states: [],
          events: [],
          timeline: [],
          previous,
          down: null,
          up: null,
        };

        history.set(report.name, entry);
      }

      const up = health.up(report);
      const initial = entry.previous.size === 0;

      let response = entry.up === true;

      if (response) {
        response = !up;
      }

      if (response) {
        entry.down = time;
      }

      const checked = entry.up === false;
      const recovered = checked && up;

      entry.up = up;

      const emitted = [];
      const actions = setting.intent?.actions ?? [];
      const handled = new Set(entry.handled ?? []);

      for (const action of actions) {
        let returned = action.name !== report.name;

        if (!returned) {
          returned = handled.has(action.id);
        }

        if (returned) {
          continue;
        }

        let selection = !action.id;

        if (!selection) {
          selection = !Number.isFinite(action.time);
        }

        if (selection) {
          continue;
        }

        const check = "operation";
        const value = action.command;
        const source = setting.source;
        const event = { ...action, check, value, source };

        entry.events.push(event);

        emitted.push(event.id);

        handled.add(action.id);
      }

      const retained = new Set(actions.map((action) => action.id));

      entry.handled = [...handled].filter((id) => retained.has(id));

      const expected = setting.intent?.services?.[report.name];

      let resolved = expected?.state === "up";

      if (resolved) {
        resolved = expected.pending;
      }

      let settled;

      if (resolved) {
        settled = entry.settled !== expected.id;
      }

      let expired = resolved && settled;

      if (expired) {
        expired = entry.failed !== expected.id;
      }

      if (expired) {
        expired = !waiting(expected, entry, time);
      }

      if (expired) {
        entry.previous.clear();

        entry.failed = expected.id;
      }

      const context = { entry, setting, reports, emitted, initial, history };

      for (const check of observations(report)) {
        const previous = entry.previous.get(check.check);

        if (previous?.value === check.value) {
          continue;
        }

        if (planned(report, check, context)) {
          continue;
        }

        entry.previous.set(check.check, check);

        const supported = !previous;

        let within;

        if (supported) {
          const success = check.level === "success";

          let equal;

          if (!success) {
            let recognized = report.system === "inactive";

            if (recognized) {
              recognized = expected?.state !== "up";
            }

            equal = recognized;
          }

          const allowed = success || equal;

          within = allowed;
        }

        const confirmed = supported && within;

        let level;

        if (confirmed) {
          level = "info";
        } else {
          level = check.level;
        }

        const id = randomUUID();
        const source = setting.source;

        let summary;

        if (level === "success") {
          summary = "restored";
        } else if (level === "warning") {
          summary = "transition";
        } else if (level === "error") {
          summary = "lost";
        } else {
          summary = "observed";
        }

        if (["cpu", "memory", "disk"].includes(check.check)) {
          if (level === "warning") {
            summary = "usage";
          } else if (level === "error") {
            summary = "exhausted";
          } else if (level === "success") {
            summary = "normalized";
          }
        } else if (check.check === "system") {
          if (level === "success") {
            summary = "started";
          } else {
            let accepted = check.value === "inactive";

            if (accepted) {
              accepted = level === "info";
            }

            if (accepted) {
              summary = "stopped";
            } else if (level === "error") {
              summary = "fault";
            }
          }
        }

        const event = { ...check, level, time, id, source, summary };

        entry.events.push(event);

        emitted.push(event.id);
      }

      const completed = expected?.completed;
      const started = setting.started ?? time;

      let compatible;

      if (up) {
        compatible = completed;
      }

      let supplied = up && compatible;

      if (supplied) {
        supplied = started >= completed;
      }

      if (supplied) {
        entry.settled = expected.id;
      }

      let safe;

      if (up) {
        safe = completed;
      }

      let missing = up && safe;

      if (missing) {
        missing = started >= completed;
      }

      if (missing) {
        for (const check of observations(report)) {
          entry.previous.set(check.check, check);
        }
      }

      entry.events = entry.events.filter((event) => {
        const valid = time - event.time < policy.retention;

        return valid;
      });
      report.events = entry.events;
      entry.timeline = entry.timeline.filter((sample) => {
        const valid = time - sample.time < policy.retention;

        return valid;
      });
      entry.samples = entry.timeline.map((sample) => {
        const result = sample.latency ?? null;

        return result;
      });
      entry.states = entry.timeline.map((sample) => sample.state);

      entry.samples.push(report.latency ?? null);

      const state = level(report);

      const positive = entry.events.some((event) => {
        let result = emitted.includes(event.id);

        if (result) {
          result = event.level === "success";
        }

        return result;
      });

      let changed = recovered || positive;

      if (changed) {
        changed = state === ".";
      }

      let glyph;

      if (changed) {
        glyph = "+";
      } else {
        glyph = state;
      }

      entry.states.push(glyph);

      const id = randomUUID();
      const resource = report.resource;
      const latency = report.latency;

      const sample = {
        id,
        time,
        state: entry.states.at(-1),
        events: emitted,
        resource,
        latency,
        pid: report.pid,
        commit: report.commit,
        mode: report.mode,
        replication: report.replication,
        up,
      };

      entry.timeline.push(sample);

      if (entry.states.length > policy.samples) {
        entry.states.shift();
      }

      if (entry.samples.length > policy.samples) {
        entry.samples.shift();
      }

      if (entry.timeline.length > policy.samples) {
        entry.timeline.shift();
      }
    }
  }

  function read(name) {
    const report = reports.find((report) => {
      return report.name === name;
    });

    const entry = history.get(name);
    const result = { report, entry, reports };

    return result;
  }

  function dump() {
    const entries = Array.from(history, function pair([name, value]) {
      const previous = Array.from(value.previous);
      const result = [name, { ...value, previous }];

      return result;
    });

    const values = reports.map((report) => {
      const result = { ...report, events: undefined };

      return result;
    });

    const result = { reports: values, entries };

    return result;
  }

  function load(value) {
    history.clear();

    if (option.order) {
      reports = option.order(value.reports);
    } else {
      reports = order(value.reports);
    }

    for (const [name, entry] of value.entries) {
      const previous = new Map(entry.previous);
      const timeline = entry.timeline ?? [];
      const states = entry.states ?? timeline.map((sample) => sample.state);

      let samples = entry.samples;

      if (samples == null) {
        samples = timeline.map((sample) => {
          const latency = sample.latency ?? null;

          return latency;
        });
      }

      history.set(name, { ...entry, previous, timeline, states, samples });
    }

    for (const report of reports) {
      report.events = history.get(report.name)?.events ?? [];
    }
  }

  function merge(values) {
    if (option.order) {
      reports = option.order(values);
    } else {
      reports = order(values);
    }

    const missing = reports.filter((report) => {
      const valid = !history.has(report.name);

      return valid;
    });

    for (const report of missing) {
      const previous = new Map();

      const entry = {
        samples: [],
        states: [],
        events: [],
        timeline: [],
        previous,
        down: null,
        up: null,
      };

      history.set(report.name, entry);
    }

    for (const report of reports) {
      report.events = history.get(report.name)?.events ?? [];
    }
  }

  const output = { record, read, dump, load, merge };

  return output;
}

function waiting(expected, entry, time) {
  let pending = expected?.pending;

  if (pending) {
    pending = expected.state === "up";
  }

  let settled = expected;

  if (settled) {
    settled = entry?.settled === expected.id;
  }

  let valid = !pending;

  if (!valid) {
    valid = settled;
  }

  if (valid) {
    return false;
  }

  if (expected.until > time) {
    return true;
  }

  let response = !expected.working;

  if (!response) {
    response = !Number.isSafeInteger(expected.pid);
  }

  if (response) {
    return false;
  }

  try {
    process.kill(expected.pid, 0);

    return true;
  } catch {
    return false;
  }
}

function planned(report, check, option) {
  if (["cpu", "memory", "disk"].includes(check.check)) {
    return false;
  }

  const { entry, setting, reports, emitted, initial, history } = option;
  const time = setting.time ?? Date.now();
  const services = setting.intent?.services ?? {};
  const expected = services[report.name];

  let answer = expected?.state === "down";

  if (!answer) {
    answer = waiting(expected, entry, time);
  }

  if (answer) {
    return true;
  }

  const requested = entry.events.some((event) => {
    let result = emitted.includes(event.id);

    if (result) {
      result = event.check === "operation";
    }

    return result;
  });

  if (requested) {
    return true;
  }

  let prepared;

  if (initial) {
    prepared = report.system === "inactive";
  }

  let selection = initial && prepared;

  if (selection) {
    selection = expected?.state !== "up";
  }

  if (selection) {
    selection = check.check !== "system";
  }

  if (selection) {
    return true;
  }

  let ready = report.role === "DB";

  if (ready) {
    ready = report.system === "active";
  }

  if (ready) {
    ready = check.check === "database";
  }

  if (ready) {
    const backends = reports.filter((report) => {
      return report.role === "WAS";
    });

    let expected = backends.length > 0;

    if (expected) {
      expected = backends.every((report) => {
        const expected = services[report.name];
        const down = expected?.state === "down";

        let result = down;

        if (!result) {
          result = waiting(expected, history.get(report.name), time);
        }

        return result;
      });
    }

    if (expected) {
      return true;
    }
  }

  let connection = report.role === "WAS";

  if (connection) {
    connection = ["database", "readiness"].includes(check.check);
  }

  if (!connection) {
    return false;
  }

  const verified = reports.some((report) => {
    let valid = report.role !== "DB";

    if (!valid) {
      valid = health.up(report);
    }

    if (valid) {
      return false;
    }

    const expected = services[report.name];

    let result = expected?.state === "down";

    if (!result) {
      result = waiting(expected, history.get(report.name), time);
    }

    return result;
  });

  return verified;
}

function flag(value) {
  if (value === true) {
    return "success";
  }

  if (value === false) {
    return "error";
  }

  return "info";
}

function observations(report) {
  const events = [];

  function add(check, value, level) {
    const name = report.name;

    events.push({ name, check, value, level });
  }

  if (report.role === "WAS") {
    add("liveness", report.live, flag(report.live));

    add("readiness", report.ready, flag(report.ready));
  }

  if (report.role === "WEB") {
    add("readiness", report.ready, flag(report.ready));
  }

  if (["WAS", "DB"].includes(report.role)) {
    const state = report.database ?? report.state;

    let level = "error";

    if (state === "ready") {
      level = "success";
    } else if (["unknown", "unconfigured", ""].includes(state)) {
      level = "info";
    }

    add("database", state, level);
  }

  if (report.role === "EXTERNAL") {
    let checks;

    if (report.name === "Tailscale") {
      checks = ["daemon", "funnel"];
    } else {
      checks = ["state"];
    }

    for (const check of checks) {
      const value = report[check];

      let valid = value === undefined;

      if (!valid) {
        valid = value === "";
      }

      if (valid) {
        continue;
      }

      let level = "error";

      if (value === "ready") {
        level = "success";
      } else if (["unknown", "unconfigured"].includes(value)) {
        level = "info";
      } else if (["activating", "reloading"].includes(value)) {
        level = "warning";
      }

      add(check, value, level);
    }
  }

  if (report.unit) {
    const transitions = ["activating", "deactivating", "reloading"];

    let level = flag(report.system === "active");

    if (transitions.includes(report.system)) {
      level = "warning";
    } else if (report.system === "unknown") {
      level = "info";
    }

    add("system", report.system, level);
  }

  for (const name of ["cpu", "memory", "disk"]) {
    const value = report.resource?.[name];

    if (!Number.isFinite(value)) {
      continue;
    }

    const level = resource.tone(name, value);

    let state;

    if (level === "success") {
      state = "ready";
    } else {
      state = level;
    }

    add(name, state, level);

    events.at(-1).amount = value;
  }

  return events;
}

export function checks(report) {
  const result = observations(report).map((event) => event.level);

  return result;
}

export function events(report) {
  const result = report.events ?? [];

  return result;
}

export async function* follow(manifest, name, level, option = {}) {
  const signal = option.signal;
  const record = option.record ?? session();

  let valid = !option.record;

  if (valid) {
    valid = option.initial;
  }

  if (valid) {
    record.record([option.initial]);
  }

  const seen = new Set();

  while (!signal?.aborted) {
    const report = record.read(name).report;

    let entries;

    if (report) {
      entries = events(report);
    } else {
      entries = [];
    }

    const retained = new Set(entries.map((event) => event.id));

    for (const id of seen) {
      if (!retained.has(id)) {
        seen.delete(id);
      }
    }

    for (const event of entries) {
      if (seen.has(event.id)) {
        continue;
      }

      seen.add(event.id);

      if (event.level === level) {
        yield event;
      }
    }

    const setting = { signal };

    await delay(5000, undefined, setting);

    const collect = option.collect ?? health.health;
    const reports = await collect(manifest, setting);

    record.record(reports);
  }
}

function level(report) {
  const results = checks(report);

  if (results.includes("error")) {
    return "x";
  }

  if (results.includes("warning")) {
    return "!";
  }

  let result;

  if (health.up(report)) {
    result = ".";
  } else {
    result = "x";
  }

  return result;
}

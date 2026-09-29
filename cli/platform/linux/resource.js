import * as fs from "node:fs/promises";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import * as path from "#cli/core/path.js";
import * as system from "#cli/core/system.js";
import * as disk from "#cli/core/disk.js";
import { scopes } from "#cli/core/measurement.js";

async function capacity(group) {
  let total = os.availableParallelism();
  let location = group;

  while (true) {
    try {
      const filename = path.control(location, "cpu.max");
      const content = await fs.readFile(filename, "utf8");
      const [quota, period] = content.trim().split(/\s+/).map(Number);

      let value = Number.isFinite(quota);

      if (value) {
        value = quota > 0;
      }

      if (value) {
        value = period > 0;
      }

      if (value) {
        total = Math.min(total, quota / period);
      }
    } catch (failure) {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    }

    let report = !location;

    if (!report) {
      report = location === "/";
    }

    if (report) {
      return total;
    }

    location = path.parent(location);
  }
}

async function processes(group) {
  const filename = path.control(group, "cgroup.procs");
  const content = await fs.readFile(filename, "utf8");

  const pids = content
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => {
      return pid > 0;
    });

  if (!pids.length) {
    return null;
  }

  const values = await Promise.all(
    pids.map(async function memory(pid) {
      const filename = path.metrics(pid);
      const contents = await fs.readFile(filename, "utf8");
      const match = contents.match(/^Pss:\s+(\d+)/m);

      let result;

      if (match) {
        result = Number(match[1]) * 1024;
      } else {
        result = null;
      }

      return result;
    }),
  );

  if (
    values.some((value) => {
      return value === null;
    })
  ) {
    return null;
  }

  const output = values.reduce((total, value) => {
    const text = total + value;

    return text;
  }, 0);

  return output;
}

async function usage(group) {
  const filename = path.control(group, "cpu.stat");
  const content = await fs.readFile(filename, "utf8");
  const match = content.match(/^usage_usec\s+(\d+)/m);

  let result;

  if (match) {
    result = Number(match[1]);
  } else {
    result = null;
  }

  return result;
}

function comparable(previous, sample) {
  if (!previous) {
    return false;
  }

  let identity = previous.pid === sample.pid;

  if (identity) {
    identity = previous.group === sample.group;
  }

  let measured = Number.isFinite(sample.counter);

  if (measured) {
    measured = Number.isFinite(previous.counter);
  }

  const increasing = sample.counter >= previous.counter;
  const result = identity && measured && increasing;

  return result;
}

export function session() {
  const samples = new Map();

  async function read(report, option = {}) {
    const scope = scopes[report.role];
    const storage = await disk.read(scope);

    let cpu = null;
    let memory = null;
    let cores = null;
    let resident = null;
    let measured = path.system();

    if (measured) {
      measured = report.pid;
    }

    if (measured) {
      measured = ["WAS", "DB"].includes(report.role);
    }

    if (measured) {
      try {
        const state = await system.state(report, option);
        const group = state.ControlGroup;

        let answer = group;

        if (answer) {
          answer = Number(state.MainPID) === report.pid;
        }

        if (answer) {
          const values = await Promise.all([
            usage(group),
            processes(group),
            capacity(group),
          ]);

          const [counter, bytes, parallel] = values;
          const time = performance.now();
          const previous = samples.get(report.name);
          const pid = report.pid;
          const sample = { pid, group, counter, time };

          let elapsed;

          if (previous) {
            elapsed = (time - previous.time) * 1000;
          } else {
            elapsed = 0;
          }

          let valid = comparable(previous, sample);

          if (valid) {
            valid = elapsed > 0;
          }

          if (valid) {
            cores = (counter - previous.counter) / elapsed;
            cpu = (cores / parallel) * 100;
          }

          resident = bytes;

          if (Number.isFinite(bytes)) {
            memory = (bytes / os.totalmem()) * 100;
          } else {
            memory = null;
          }

          samples.set(report.name, sample);
        }
      } catch {
        samples.delete(report.name);
      }
    } else {
      samples.delete(report.name);
    }

    const percentage = storage?.usage ?? null;
    const used = storage?.used ?? null;
    const total = storage?.total ?? null;
    const free = storage?.free ?? null;
    const virtual = storage?.virtual ?? false;
    const processors = os.availableParallelism();
    const ram = os.totalmem();

    const response = {
      cpu,
      memory,
      disk: percentage,
      cores,
      resident,
      used,
      total,
      free,
      virtual,
      processors,
      ram,
      scope,
    };

    return response;
  }

  function reset() {
    samples.clear();
  }

  const output = { read, reset };

  return output;
}

import * as os from "node:os";
import * as command from "#cli/core/process.js";
import * as disk from "#cli/core/disk.js";
import { scopes } from "#cli/core/measurement.js";

export function session() {
  async function read(report, option = {}) {
    const scope = scopes[report.role];
    const storage = await disk.read(scope);
    const processors = os.availableParallelism();
    const ram = os.totalmem();

    let cpu = null;
    let resident = null;
    let memory = null;
    let cores = null;
    let valid = ["WAS", "DB"].includes(report.role);

    if (valid) {
      valid = report.pid;
    }

    if (valid) {
      try {
        const args = ["-axo", "pid=,ppid=,%cpu=,rss="];
        const settings = { signal: option.signal, env: { LC_ALL: "C" } };
        const output = await command.run("/bin/ps", args, settings);

        const rows = output.output
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));

        const pids = new Set([report.pid]);

        let added = true;

        while (added) {
          added = false;

          for (const [pid, parent] of rows) {
            let descendant = pids.has(parent);

            if (descendant) {
              descendant = !pids.has(pid);
            }

            if (descendant) {
              pids.add(pid);

              added = true;
            }
          }
        }

        const values = rows.filter(([pid]) => pids.has(pid));

        if (values.length) {
          const usage = values.reduce((total, row) => {
            const value = total + row[2];

            return value;
          }, 0);

          resident = values.reduce((total, row) => {
            const value = total + row[3] * 1024;

            return value;
          }, 0);
          cores = usage / 100;
          cpu = usage / processors;
          memory = (resident / ram) * 100;
        }
      } catch {
        cpu = null;
        memory = null;
        resident = null;
        cores = null;
      }
    }

    const percentage = storage?.usage ?? null;
    const used = storage?.used ?? null;
    const total = storage?.total ?? null;
    const free = storage?.free ?? null;

    const answer = {
      cpu,
      memory,
      disk: percentage,
      cores,
      resident,
      used,
      total,
      free,
      virtual: false,
      processors,
      ram,
      scope,
    };

    return answer;
  }

  function reset() {}

  const result = { read, reset };

  return result;
}

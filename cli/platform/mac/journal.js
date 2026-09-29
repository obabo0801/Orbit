import * as fs from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";

function filename(service) {
  const role = service.unit.slice(6, -8);

  return path.journal(role);
}

async function read(service) {
  const file = filename(service);

  const text = await fs.readFile(file, "utf8").catch((failure) => {
    if (failure.code === "ENOENT") {
      return "";
    }

    throw failure;
  });

  const rows = text.split("\n").filter(Boolean);
  const entries = [];

  for (const row of rows) {
    try {
      entries.push(JSON.parse(row));
    } catch {
      continue;
    }
  }

  return entries;
}

export async function entries(service, option = {}) {
  let values = await read(service);

  if (option.cursor) {
    const index = values.findIndex((entry) => {
      return entry.__CURSOR === option.cursor;
    });

    if (index < 0) {
      throw error("expired");
    }

    values = values.slice(index);
  } else {
    values = values.slice(-(option.limit ?? 100));
  }

  const result = values.map((entry) => {
    const id = entry.__CURSOR;
    const time = Number(entry.__REALTIME_TIMESTAMP) / 1000;
    const text = entry.MESSAGE;
    const priority = entry.PRIORITY;
    const result = { id, time, text, priority };

    return result;
  });

  return result;
}

export async function follow(services, option = {}) {
  const cursors = new Map();

  let initial = true;

  while (!option.signal?.aborted) {
    for (const service of services) {
      if (!service.unit) {
        continue;
      }

      const values = await read(service);
      const cursor = cursors.get(service.unit);

      let selected;

      if (initial) {
        let index;

        if (option.cursor) {
          index = values.findIndex((entry) => {
            return entry.__CURSOR === option.cursor;
          });
        } else {
          index = -1;
        }

        let valid = option.cursor;

        if (valid) {
          valid = index < 0;
        }

        if (valid) {
          throw error("expired");
        }

        if (index >= 0) {
          selected = values.slice(index);
        } else {
          selected = values.slice(-100);
        }
      } else {
        const index = values.findIndex((entry) => {
          return entry.__CURSOR === cursor;
        });

        selected = values.slice(index + 1);
      }

      for (const entry of selected) {
        const stamp = new Date(
          Number(entry.__REALTIME_TIMESTAMP) / 1000,
        ).toISOString();

        const plain = stamp + " " + entry.MESSAGE;

        let line;

        if (option.cursor) {
          line = JSON.stringify(entry);
        } else {
          line = plain;
        }

        let text;

        if (option.format) {
          text = option.format(line);
        } else {
          text = line;
        }

        process.stdout.write(text + "\n");
      }

      if (values.length) {
        cursors.set(service.unit, values.at(-1).__CURSOR);
      }
    }

    initial = false;

    try {
      await setTimeout(250, undefined, { signal: option.signal });
    } catch (failure) {
      if (failure.name !== "AbortError") {
        throw failure;
      }
    }
  }
}

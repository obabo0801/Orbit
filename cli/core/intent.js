import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";

const retention = 86400000;
const grace = 30000;

function valid(value) {
  if (value?.version !== 1) {
    return false;
  }

  let services = value.services;

  if (services) {
    services = typeof value.services === "object";
  }

  const actions = Array.isArray(value.actions);
  const result = services && actions;

  return result;
}

export async function read(option = {}) {
  const filename = option.filename ?? path.intent;

  try {
    const details = await fs.lstat(filename);

    let report = !details.isFile();

    if (!report) {
      report = details.isSymbolicLink();
    }

    if (!report) {
      report = details.size > 1048576;
    }

    if (report) {
      return null;
    }

    const content = await fs.readFile(filename, "utf8");
    const value = JSON.parse(content);

    let result;

    if (valid(value)) {
      result = value;
    } else {
      result = null;
    }

    return result;
  } catch {
    return null;
  }
}

export async function clear() {
  let details;

  try {
    details = await fs.lstat(path.intent);
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return;
    }

    throw failure;
  }

  const file = details.isFile();
  const single = details.nlink === 1;
  const owner = details.uid === 0;
  const restricted = (details.mode & 0o077) === 0;
  const valid = file && single && owner && restricted;

  let output = !valid;

  if (!output) {
    output = !(await read());
  }

  if (output) {
    throw error("changed");
  }

  await fs.unlink(path.intent);
}

async function write(value, option) {
  const filename = option.filename ?? path.intent;
  const temporary = filename + ".tmp";
  const write = fs.constants.O_WRONLY;
  const create = fs.constants.O_CREAT;
  const truncate = fs.constants.O_TRUNC;
  const follow = fs.constants.O_NOFOLLOW;
  const flags = write | create | truncate | follow;
  const file = await fs.open(temporary, flags, 0o600);

  try {
    try {
      const content = JSON.stringify(value) + "\n";

      await file.writeFile(content);

      await file.sync();
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
}

export async function begin(command, services, manifest, option = {}) {
  const value = (await read(option)) ?? {
    version: 1,
    services: {},
    actions: [],
  };

  const time = option.time ?? Date.now();

  value.actions = value.actions.filter((action) => {
    const valid = time - action.time < retention;

    return valid;
  });

  const id = randomUUID();

  let state;

  if (command === "stop") {
    state = "down";
  } else {
    state = "up";
  }

  const until = time + grace;

  const selected = services.filter((service) => {
    return service.role !== "MONITOR";
  });

  const targets = new Map();

  for (const service of selected) {
    const names = [service.name];

    if (service.role === "CADDY") {
      const web = manifest.services.filter((service) => {
        return service.role === "WEB";
      });

      names.push(...web.map((service) => service.name));
    }

    targets.set(service.name, names);

    const pid = process.pid;

    for (const name of names) {
      value.services[name] = {
        id,
        state,
        until,
        pending: true,
        working: true,
        pid,
      };
    }
  }

  await write(value, option);

  const result = { id, targets, option };

  return result;
}

export async function finish(request, service, command, option = {}) {
  const value = await read(request.option);

  if (!value) {
    return;
  }

  const time = option.time ?? Date.now();
  const names = request.targets.get(service.name) ?? [];

  for (const name of names) {
    const expected = value.services[name];

    if (expected?.id !== request.id) {
      continue;
    }

    const up = expected.state === "up";

    let successful;

    if (up) {
      successful = !option.failed;
    }

    expected.pending = up && successful;

    const stopped = command === "stop";

    let ready = stopped;

    if (ready) {
      ready = expected.state === "up";
    }

    let working = false;

    if (ready) {
      working = !option.failed;
    }

    expected.working = working;

    let completion = command === "start";

    if (completion) {
      completion = !option.failed;
    }

    if (completion) {
      expected.completed = time;
    } else {
      expected.completed = null;
    }

    expected.until = time + grace;

    if (option.failed) {
      expected.until = time;
    }

    let valid = option.changed;

    if (!valid) {
      valid = option.failed;
    }

    if (valid) {
      const id = randomUUID();

      let level;

      if (option.failed) {
        level = "error";
      } else if (stopped) {
        level = "info";
      } else {
        level = "success";
      }

      let summary;

      if (option.failed) {
        summary = `${command}failed`;
      } else if (stopped) {
        summary = "stopped";
      } else {
        summary = "started";
      }

      const action = { id, name, time, level, summary, command };

      value.actions.push(action);
    }
  }

  await write(value, request.option);
}

export async function end(request) {
  const value = await read(request.option);

  if (!value) {
    return;
  }

  let changed = false;

  for (const expected of Object.values(value.services)) {
    let valid = expected.id !== request.id;

    if (!valid) {
      valid = !expected.working;
    }

    if (valid) {
      continue;
    }

    expected.working = false;
    expected.until = Date.now();
    changed = true;
  }

  if (changed) {
    await write(value, request.option);
  }
}

import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";
import { setTimeout as delay } from "node:timers/promises";
import * as owner from "#cli/core/owner.js";

async function read(filename) {
  try {
    const result = JSON.parse(await fs.readFile(filename, "utf8"));

    return result;
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return null;
    }

    if (failure instanceof SyntaxError) {
      return undefined;
    }

    throw failure;
  }
}

async function open(filename, record) {
  let handle;

  try {
    handle = await fs.open(filename, "wx", 0o600);
  } catch (failure) {
    if (failure.code === "EEXIST") {
      return false;
    }

    throw failure;
  }

  try {
    const contents = JSON.stringify(record) + "\n";

    await handle.writeFile(contents);
  } catch (failure) {
    await fs.unlink(filename);

    throw failure;
  } finally {
    await handle.close();
  }

  return true;
}

async function discard(filename, record) {
  let handle;

  try {
    handle = await fs.open(filename, "r");

    const contents = await handle.readFile("utf8");
    const found = JSON.parse(contents);

    if (found.token !== record.token) {
      return false;
    }

    const held = await handle.stat();
    const present = await fs.lstat(filename);

    let same = held.ino === present.ino;

    if (same) {
      same = held.dev === present.dev;
    }

    let file = false;

    if (same) {
      file = present.isFile();
    }

    const valid = same && file;

    if (!valid) {
      return false;
    }

    await fs.unlink(filename);

    return true;
  } catch (failure) {
    const missing = failure.code === "ENOENT";

    let malformed = false;

    if (!missing) {
      malformed = failure instanceof SyntaxError;
    }

    const absent = missing || malformed;

    if (absent) {
      return false;
    }

    throw failure;
  } finally {
    await handle?.close();
  }
}

function collision(name, active) {
  const failure = error("locked");

  failure.lock = name;

  const dashboard = name === "dashboard";
  const running = active === true;
  const duplicate = dashboard && running;

  failure.duplicate = duplicate;

  return failure;
}

async function acquire(name, filename, record) {
  const guard = path.recovery(name);

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await open(filename, record)) {
      return;
    }

    const previous = await read(filename);

    if (previous === null) {
      continue;
    }

    if (previous === undefined) {
      await delay(20);

      continue;
    }

    const active = await owner.active(previous, name);

    if (active !== false) {
      throw collision(name, active);
    }

    if (!(await open(guard, record))) {
      const recovering = await read(guard);

      let inactive = false;

      if (recovering) {
        const active = await owner.active(recovering);

        inactive = active === false;
      }

      if (inactive) {
        await discard(guard, recovering);
      }

      await delay(20);

      continue;
    }

    try {
      if (!(await discard(filename, previous))) {
        continue;
      }

      if (await open(filename, record)) {
        return;
      }
    } finally {
      await discard(guard, record);
    }
  }

  throw collision(name, null);
}

export async function hold(filename) {
  const token = randomUUID();
  const record = await owner.create(token);

  await acquire("history", filename, record);

  return async function release() {
    await discard(filename, record);
  };
}

export async function lock(name, option = {}) {
  const directories = path.path();

  const operational = [
    "promotion",
    "failover",
    "update",
    "deployment",
  ].includes(name);

  let filename = directories[name];

  if (operational) {
    filename = path.temporary(name + ".lock");
  }

  if (
    ![
      "dashboard",
      "service",
      "promotion",
      "failover",
      "update",
      "deployment",
    ].includes(name)
  ) {
    throw error("internal");
  }

  const system = path.system();

  let mode;

  if (system) {
    mode = 0o711;
  } else {
    mode = 0o700;
  }

  const settings = { recursive: true, mode };

  await fs.mkdir(directories.runtime, settings);

  const operating = path.system();

  let root = false;

  if (operating) {
    root = process.getuid?.() === 0;
  }

  if (root) {
    await fs.chmod(directories.runtime, 0o711);
  }

  const token = randomUUID();
  const record = await owner.create(token);

  while (true) {
    option.signal?.throwIfAborted();

    try {
      await acquire(name, filename, record);

      break;
    } catch (failure) {
      const collision = failure.code === "locked";
      const waiting = option.wait === true;
      const pending = collision && waiting;

      if (!pending) {
        throw failure;
      }

      await option.observe?.();

      await delay(250, undefined, { signal: option.signal });
    }
  }

  const result = async function release() {
    await discard(filename, record);
  };

  return result;
}

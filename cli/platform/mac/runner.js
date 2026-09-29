import * as child from "node:child_process";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import { setTimeout } from "node:timers/promises";

const [role, program, ...args] = process.argv.slice(2);

if (!["db", "was", "caddy", "monitor"].includes(role)) {
  throw new Error("LAUNCHD_SERVICE: Unsupported service.");
}

let uid = 0;
let gid = 0;

if (role !== "monitor") {
  const name = "orbit" + role;
  const user = await command.run("/usr/bin/id", ["-u", name]);
  const group = await command.run("/usr/bin/id", ["-g", name]);

  uid = Number(user.output.trim());
  gid = Number(group.output.trim());
}

async function directory(filename, owner, group) {
  await fs.mkdir(filename, { mode: 0o755 }).catch((failure) => {
    if (failure.code !== "EEXIST") {
      throw failure;
    }
  });

  const details = await fs.lstat(filename);

  if (!details.isDirectory()) {
    throw new Error("LAUNCHD_PATH: Invalid runtime directory.");
  }

  if (details.uid !== owner) {
    throw new Error("LAUNCHD_OWNER: Invalid runtime owner.");
  }

  await fs.chown(filename, owner, group);
}

await directory(path.runtime, 0, 0);

const directories = { db: path.socket, caddy: path.caddy.runtime };
const location = directories[role];

if (location) {
  await fs.mkdir(location, { mode: 0o750 }).catch((failure) => {
    if (failure.code !== "EEXIST") {
      throw failure;
    }
  });

  const details = await fs.lstat(location);

  if (!details.isDirectory()) {
    throw new Error("LAUNCHD_PATH: Invalid service runtime directory.");
  }

  await fs.chown(location, uid, gid);
}

let stopped = false;
let running;

function stop(signal) {
  stopped = true;

  if (running?.pid) {
    let forwarded;

    if (role === "db") {
      forwarded = "SIGINT";
    } else {
      forwarded = signal;
    }

    try {
      process.kill(-running.pid, forwarded);
    } catch (failure) {
      if (failure.code !== "ESRCH") {
        throw failure;
      }
    }
  }
}

process.on("SIGTERM", () => stop("SIGTERM"));

process.on("SIGINT", () => stop("SIGINT"));

const levels = {
  debug: 7,
  info: 6,
  notice: 5,
  log: 6,
  warn: 4,
  warning: 4,
  error: 3,
  fatal: 2,
  panic: 0,
};

function severity(message, fallback) {
  let level;

  try {
    const record = JSON.parse(message);

    if (typeof record.level === "string") {
      level = record.level.toLowerCase();
    }
  } catch {
    const match = message.match(
      /\b(DEBUG\d?|INFO|NOTICE|LOG|WARNING|ERROR|FATAL|PANIC):/,
    );

    if (match) {
      level = match[1].toLowerCase().replace(/\d$/, "");
    }
  }

  const priority = levels[level] ?? fallback;

  return priority;
}

function stream(source, priority) {
  const option = { input: source, crlfDelay: Infinity };
  const reader = readline.createInterface(option);

  reader.on("line", (message) => {
    const id = crypto.randomUUID();
    const time = String(Date.now() * 1000);
    const level = severity(message, priority);

    const record = {
      __CURSOR: id,
      __REALTIME_TIMESTAMP: time,
      MESSAGE: message,
      PRIORITY: level,
    };

    const text = JSON.stringify(record) + "\n";

    process.stdout.write(text);
  });

  return reader;
}

while (!stopped) {
  const stdio = ["ignore", "pipe", "pipe"];
  const option = { detached: true, stdio, uid, gid };

  running = child.spawn(program, args, option);

  const readers = [stream(running.stdout, 6), stream(running.stderr, 3)];

  const code = await new Promise((resolve) => {
    running.once("error", () => resolve(1));

    running.once("close", resolve);
  });

  for (const reader of readers) {
    reader.close();
  }

  running = null;

  let valid = stopped;

  if (!valid) {
    valid = code === 0;
  }

  if (valid) {
    break;
  }

  await setTimeout(3000);
}

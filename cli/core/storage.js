import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as location from "node:path";
import * as host from "#cli/core/host.js";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import { error } from "#cli/core/error.js";

export function candidates(entries, requested = process.env.ORBIT_WSL) {
  const output = entries.filter(function candidate(entry) {
    let result;

    if (requested) {
      result = entry.name === requested;
    } else {
      result = /^Ubuntu(?:$|[-\s])/i.test(entry.name);
    }

    return result;
  });

  return output;
}

async function capable(operation, execute) {
  const args = ["--help"];
  const setting = { encoding: "utf16le", allow: true };
  const report = await execute.run("wsl.exe", args, setting);

  let required;

  if (operation === "move") {
    required = "--move";
  } else {
    required = "--location";
  }

  if (!report.output.includes(required)) {
    throw error("preparation", { reason: "upgrade" });
  }

  if (operation !== "move") {
    return;
  }

  const version = await execute.run("wsl.exe", ["--version"], setting);
  const match = version.output.match(/WSL[^\r\n]*?(\d+)\.(\d+)\.(\d+)/i);

  if (!match) {
    throw error("preparation", { reason: "upgrade" });
  }

  const [major, minor, patch] = match.slice(1).map(Number);

  let newer = major > 2;

  if (!newer) {
    const release = major === 2;

    let within;

    if (release) {
      within = minor > 7;
    }

    newer = release && within;
  }

  let fixed = major === 2;

  if (fixed) {
    fixed = minor === 7;
  }

  if (fixed) {
    fixed = patch >= 12;
  }

  let value = !newer;

  if (value) {
    value = !fixed;
  }

  if (value) {
    throw error("preparation", { reason: "upgrade" });
  }
}

async function target(drive, option) {
  const files = option.fs ?? fs;
  const execute = option.command ?? command;
  const report = await host.read({ command: execute });

  const volume = report.drives.find((entry) => {
    return entry.name === drive;
  });

  let output = !volume;

  if (!output) {
    output = !host.usable(volume);
  }

  if (output) {
    throw error("preparation", { reason: "volume" });
  }

  const destination = path.ubuntu(drive);

  try {
    await files.lstat(destination);

    throw error("collision");
  } catch (failure) {
    if (failure.code !== "ENOENT") {
      throw failure;
    }
  }

  let parent = location.win32.dirname(destination);

  while (true) {
    try {
      const actual = await files.realpath(parent);
      const root = location.win32.parse(actual).root.toUpperCase();

      if (root !== `${drive.toUpperCase()}\\`) {
        throw error("preparation", { reason: "volume" });
      }

      break;
    } catch (failure) {
      if (failure.code !== "ENOENT") {
        throw failure;
      }

      parent = location.win32.dirname(parent);
    }
  }

  const trial = await files.mkdtemp(location.win32.join(parent, "orbit-"));

  try {
    const unsafe = await attributes(trial, execute);

    if (unsafe) {
      throw error("preparation", { reason: "volume" });
    }
  } finally {
    await files.rmdir(trial);
  }

  const value = { destination, volume, entries: report.entries };

  return value;
}

async function attributes(directory, execute) {
  const escaped = directory.replaceAll("'", "''");

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$item = Get-Item -LiteralPath '${escaped}'`,
    "$invalid = [System.IO.FileAttributes]::Compressed -bor " +
      "[System.IO.FileAttributes]::Encrypted -bor " +
      "[System.IO.FileAttributes]::ReparsePoint",
    "[int]($item.Attributes -band $invalid)",
  ];

  const script = lines.join("\n");
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const report = await execute.run("powershell.exe", args);
  const value = Number(report.output.trim());

  if (!Number.isInteger(value)) {
    throw error("preparation", { reason: "volume" });
  }

  return value;
}

function same(before, after) {
  if (!after) {
    return false;
  }

  let identity = before.id === after.id;

  if (identity) {
    identity = before.name === after.name;
  }

  let settings = before.version === after.version;

  if (settings) {
    settings = before.uid === after.uid;
  }

  const result = identity && settings;

  return result;
}

async function stopped(name, execute) {
  const args = ["--list", "--running", "--quiet"];
  const setting = { encoding: "utf16le" };
  const report = await execute.run("wsl.exe", args, setting);
  const names = report.output.split(/\r?\n/).map((line) => line.trim());
  const valid = !names.includes(name);

  return valid;
}

async function shutdown(name, execute) {
  if (await stopped(name, execute)) {
    return;
  }

  const prefix = ["--distribution", name, "--user", "root", "--exec"];
  const probe = [...prefix, "/bin/cat", "/proc/1/comm"];
  const init = await execute.run("wsl.exe", probe);

  if (init.output.trim() !== "systemd") {
    throw error("preparation", { reason: "init" });
  }

  const args = [...prefix, "/usr/bin/systemctl", "poweroff"];
  const setting = { allow: true };

  await execute.run("wsl.exe", args, setting);

  for (let attempt = 0; attempt < 60; attempt++) {
    if (await stopped(name, execute)) {
      return;
    }

    await delay(500);
  }

  throw error("preparation", { reason: "running" });
}

async function digest(filename) {
  const hash = createHash("sha256");

  for await (const piece of createReadStream(filename)) {
    hash.update(piece);
  }

  return hash.digest("hex");
}

export async function move(entry, drive, option = {}) {
  if (entry.version !== 2) {
    throw error("preparation", { reason: "wslversion" });
  }

  const execute = option.command ?? command;
  const files = option.fs ?? fs;
  const checksum = option.digest ?? digest;
  const original = path.drive(entry.base);

  if (original.toUpperCase() === drive.toUpperCase()) {
    return entry.name;
  }

  await capable("move", execute);

  const { destination, volume, entries } = await target(drive, option);

  const registered = entries.find((item) => {
    return item.id === entry.id;
  });

  let unchanged = same(entry, registered);

  if (unchanged) {
    unchanged = registered.base === entry.base;
  }

  if (!unchanged) {
    throw error("preparation", { reason: "changed" });
  }

  const source = location.win32.join(entry.base, entry.file);
  const stats = await files.lstat(source);

  let output = !stats.isFile();

  if (!output) {
    output = stats.isSymbolicLink();
  }

  if (output) {
    throw error("data");
  }

  if (volume.free <= stats.size) {
    throw error("preparation", { reason: "capacity" });
  }

  await shutdown(entry.name, execute);

  const settled = await files.lstat(source);

  if (volume.free <= settled.size) {
    throw error("preparation", { reason: "capacity" });
  }

  const before = await checksum(source);

  if (!(await stopped(entry.name, execute))) {
    throw error("preparation", { reason: "running" });
  }

  const args = ["--manage", entry.name, "--move", destination];
  const code = await execute.terminal("wsl.exe", args);

  if (code !== 0) {
    throw error("preparation", { reason: "relocation" });
  }

  const report = await host.read({ command: execute });

  const relocated = report.entries.find((item) => {
    return item.id === entry.id;
  });

  let valid = same(entry, relocated);

  if (valid) {
    valid = relocated.base === destination;
  }

  if (!valid) {
    throw error("data", { reason: "relocation" });
  }

  const filename = location.win32.join(relocated.base, relocated.file);
  const after = await checksum(filename);

  if (before !== after) {
    throw error("data", { reason: "checksum" });
  }

  return entry.name;
}

export async function create(drive, option = {}) {
  const execute = option.command ?? command;

  await capable("create", execute);

  const { destination, entries } = await target(drive, option);

  if (candidates(entries).length) {
    throw error("collision");
  }

  const name = process.env.ORBIT_WSL ?? "Ubuntu";

  const args = [
    "--install",
    "Ubuntu",
    "--name",
    name,
    "--location",
    destination,
    "--version",
    "2",
    "--no-launch",
  ];

  const code = await execute.terminal("wsl.exe", args);

  if (code !== 0) {
    throw error("preparation", { reason: "distribution" });
  }

  const report = await host.read({ command: execute });

  const entry = report.entries.find((item) => {
    return item.name === name;
  });

  let ready = entry?.version === 2;

  if (ready) {
    ready = entry.base === destination;
  }

  if (!ready) {
    throw error("preparation", { reason: "reboot" });
  }

  const setup = ["--distribution", name, "--exec", "/bin/true"];
  const initialized = await execute.terminal("wsl.exe", setup);

  if (initialized !== 0) {
    throw error("preparation", { reason: "distribution" });
  }

  return name;
}

export async function prepare(selection, option = {}) {
  if (selection.name) {
    return selection.name;
  }

  if (selection.entry) {
    return move(selection.entry, selection.drive, option);
  }

  return create(selection.drive, option);
}

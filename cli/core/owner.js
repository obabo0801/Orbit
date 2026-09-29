import * as platform from "#cli/platform/index.js";
import * as mac from "#cli/platform/mac/owner.js";
import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";

function valid(record) {
  if (!record) {
    return false;
  }

  let pid = Number.isSafeInteger(record.pid);

  if (pid) {
    pid = record.pid > 0;
  }

  let token = typeof record.token === "string";

  if (token) {
    token = record.token.length > 0;
  }

  const result = pid && token;

  return result;
}

function stamp(text) {
  const end = text.lastIndexOf(")");

  if (end < 0) {
    return null;
  }

  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);

  const result = fields[19] ?? null;

  return result;
}

async function local(pid) {
  try {
    process.kill(pid, 0);
  } catch (failure) {
    if (failure.code === "ESRCH") {
      const result = { alive: false };

      return result;
    }

    if (failure.code !== "EPERM") {
      return null;
    }
  }

  if (platform.linux) {
    return native(pid);
  } else if (platform.windows) {
    return windows(pid);
  } else if (platform.mac) {
    return mac.local(pid);
  }

  return native(pid);
}

async function native(pid) {
  try {
    const text = await fs.readFile(path.task(pid), "utf8");
    const boot = await fs.readFile(path.boot, "utf8");
    const identity = `${boot.trim()}:${stamp(text)}`;
    const filename = path.adjacent(path.task(pid), "cmdline");
    const command = await fs.readFile(filename, "utf8");
    const result = { alive: true, identity, command };

    return result;
  } catch (failure) {
    if (failure.code === "ENOENT") {
      const output = { alive: false };

      return output;
    }

    const value = { alive: true };

    return value;
  }
}

async function windows(pid) {
  const fields = [
    "identity = [string]$item.CreationDate.ToUniversalTime().Ticks",
    "command = $item.CommandLine",
  ];

  const property = fields.join("; ");
  const record = `@{ ${property} } | ConvertTo-Json -Compress`;

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $item) { exit 3 }",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    record,
  ].join("; ");

  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const settings = { allow: true };

  try {
    const report = await command.run("powershell.exe", args, settings);

    if (report.code === 3) {
      const result = { alive: false };

      return result;
    }

    if (report.code !== 0) {
      return null;
    }

    const details = JSON.parse(report.output);
    const identity = details.identity;

    if (!/^\d+$/.test(identity)) {
      return null;
    }

    const invocation = details.command;
    const value = { alive: true, identity, command: invocation };

    return value;
  } catch {
    return null;
  }
}

async function distributions() {
  const args = ["--list", "--running", "--quiet"];
  const settings = { encoding: "utf16le", allow: true };

  try {
    const report = await command.run("wsl.exe", args, settings);

    if (report.code !== 0) {
      return null;
    }

    const value = report.output
      .split(/\r?\n/)
      .map(function name(line) {
        return line.replace(/^\uFEFF/, "").trim();
      })
      .filter(Boolean);

    return value;
  } catch {
    return null;
  }
}

async function linux(pid, distro, legacy = false) {
  const prefix = [
    "--distribution",
    distro,
    "--exec",
    "/usr/bin/env",
    "LC_ALL=C",
    "/bin/cat",
  ];

  const args = [...prefix, path.task(pid)];
  const settings = { allow: true };

  try {
    const report = await command.run("wsl.exe", args, settings);

    if (report.code !== 0) {
      if (report.diagnostic.includes("No such file or directory")) {
        const result = { alive: false };

        return result;
      }

      return null;
    }

    const reading = [...prefix, path.boot];
    const boot = await command.run("wsl.exe", reading, settings);

    let identity;

    if (boot.code === 0) {
      identity = `${boot.output.trim()}:${stamp(report.output)}`;
    } else {
      identity = undefined;
    }

    let text;

    if (legacy) {
      const filename = path.adjacent(path.task(pid), "cmdline");
      const reading = [...prefix, filename];
      const contents = await command.run("wsl.exe", reading, settings);

      if (contents.code === 0) {
        text = contents.output;
      }
    }

    const value = { alive: true, identity, command: text };

    return value;
  } catch {
    return null;
  }
}

function matches(record, result) {
  if (!result) {
    return null;
  }

  if (!result.alive) {
    return false;
  }

  let identified = typeof record.identity === "string";

  if (identified) {
    identified = result.identity;
  }

  if (identified) {
    return record.identity === result.identity;
  }

  return true;
}

async function foreign(record) {
  if (record.platform === "win32") {
    const result = matches(record, await windows(record.pid));

    return result;
  }

  let valid = record.platform !== "linux";

  if (!valid) {
    valid = !record.distro;
  }

  if (valid) {
    return null;
  }

  const names = await distributions();

  if (!names) {
    return null;
  }

  if (!names.includes(record.distro)) {
    return false;
  }

  const value = matches(record, await linux(record.pid, record.distro));

  return value;
}

function legacy(result, name) {
  let answer = !result;

  if (!answer) {
    answer = !result.alive;
  }

  if (answer) {
    const value = result?.alive ?? null;

    return value;
  }

  if (name === "service") {
    return true;
  }

  if (typeof result.command !== "string") {
    return null;
  }

  const entry = path.local("../index.js", import.meta.url).replace(/\\/g, "/");
  const suffix = entry.split("/").slice(-3).join("/").toLowerCase();

  const text = result.command
    .replace(/\\/g, "/")
    .replaceAll("\u0000", " ")
    .toLowerCase();

  const contextual = text.includes(suffix);
  const starting = /(?:\s|["'])start(?:\s|["']|$)/.test(text);

  let valid;

  if (contextual && starting) {
    valid = true;
  } else {
    valid = null;
  }

  return valid;
}

export async function active(record, name = "dashboard") {
  if (!valid(record)) {
    return null;
  }

  const distro = process.env.WSL_DISTRO_NAME ?? "";
  const native = record.platform === process.platform;

  let shared = process.platform === "linux";

  if (shared) {
    shared = Boolean(record.distro);
  }

  if (shared) {
    shared = Boolean(distro);
  }

  if (shared) {
    shared = record.distro !== distro;
  }

  if (record.platform) {
    let response = !native;

    if (!response) {
      response = shared;
    }

    if (response) {
      return foreign(record);
    }

    const report = matches(record, await local(record.pid));

    return report;
  }

  const present = await local(record.pid);

  let returned = !present;

  if (!returned) {
    returned = present.alive;
  }

  if (returned) {
    return legacy(present, name);
  }

  if (process.platform === "linux") {
    if (path.system()) {
      return false;
    }

    const native = legacy(await windows(record.pid), name);

    if (native !== false) {
      return native;
    }
  }

  if (platform.mac) {
    return false;
  }

  const names = await distributions();

  if (!names) {
    return null;
  }

  for (const distribution of names) {
    if (distribution === distro) {
      continue;
    }

    const result = await linux(record.pid, distribution, true);

    let chosen = !result;

    if (!chosen) {
      chosen = result.alive;
    }

    if (chosen) {
      return legacy(result, name);
    }
  }

  return false;
}

export async function create(token) {
  const pid = process.pid;
  const platform = process.platform;
  const distro = process.env.WSL_DISTRO_NAME ?? "";
  const result = await local(pid);
  const identity = result?.identity;
  const output = { pid, token, platform, distro, identity };

  return output;
}

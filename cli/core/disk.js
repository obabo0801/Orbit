import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Buffer } from "node:buffer";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import * as windows from "#cli/core/host.js";

const virtual = /microsoft.*wsl2/i.test(os.release());

let location;
let retry = 0;
let pending;

async function distribution() {
  if (process.env.WSL_DISTRO_NAME) {
    return process.env.WSL_DISTRO_NAME;
  }

  const entries = await fs.readdir(path.proc);

  for (const pid of entries.filter((entry) => /^\d+$/.test(entry))) {
    try {
      const program = await fs.readFile(path.program(pid), "utf8");

      if (program.split("\0")[0] !== "/init") {
        continue;
      }

      const environment = await fs.readFile(path.environment(pid), "utf8");

      const name = environment
        .split("\0")
        .find((entry) => entry.startsWith("WSL2_DISTRO_NAME="));

      if (name) {
        const output = name.slice(name.indexOf("=") + 1);

        return output;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function executable() {
  const content = await fs.readFile(path.mounts, "utf8");

  const mounts = content.split("\n").flatMap(function mounted(line) {
    const fields = line.split(" ");
    const boundary = fields.indexOf("-");
    const source = fields[boundary + 2] ?? "";

    if (!/^[a-z]:\\/i.test(source)) {
      const output = [];

      return output;
    }

    const root = fields[4].replace(/\\([0-7]{3})/gu, function decode(_, octal) {
      const result = String.fromCharCode(Number.parseInt(octal, 8));

      return result;
    });

    const value = [path.powershell(root)];

    return value;
  });

  const candidates = [...path.tools("powershell.exe"), ...mounts];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);

      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function locate() {
  const name = await distribution();
  const program = await executable();

  let valid = !name;

  if (!valid) {
    valid = !program;
  }

  if (valid) {
    return null;
  }

  const escaped = name.replaceAll("'", "''");

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$name = '${escaped}'`,
    ...windows.registry(),
    "$entry = @($items | Where-Object { $_.DistributionName -eq $name })",
    "if ($entry.Count -ne 1) { exit 1 }",
    "$base = $entry[0].BasePath",
    "$file = $entry[0].VhdFileName",
    "if (-not $file) { $file = 'ext4.vhdx' }",
    "$disk = Get-Item -LiteralPath (Join-Path $base $file)",
    "$disk.DirectoryName | ConvertTo-Json -Compress",
  ];

  const script = lines.join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];

  let interop = process.env.WSL_INTEROP;

  if (!interop) {
    interop = path.interop;
  }

  const env = { WSL_INTEROP: interop };
  const option = { timeout: 5000, env };
  const report = await command.run(program, args, option);
  const directory = JSON.parse(report.output.trim());

  let prepared = typeof directory !== "string";

  if (!prepared) {
    prepared = !directory;
  }

  if (prepared) {
    return null;
  }

  const normalized = directory.replace(/^\\\\\?\\/, "");
  const conversion = ["-u", normalized];
  const converted = await command.run("wslpath", conversion, { timeout: 5000 });
  const value = converted.output.trim();

  let result;

  if (value.startsWith("/")) {
    result = value;
  } else {
    result = null;
  }

  return result;
}

async function host() {
  try {
    let valid = !location;

    if (valid) {
      valid = Date.now() >= retry;
    }

    if (valid) {
      pending ??= locate().finally(function complete() {
        pending = undefined;
      });
      location = await pending;
      retry = Date.now() + 60000;
    }

    if (!location) {
      return null;
    }

    return await fs.statfs(location, { bigint: true });
  } catch {
    location = undefined;
    retry = Date.now() + 60000;

    return null;
  }
}

export async function read(scope) {
  try {
    let stats;

    if (virtual) {
      stats = await host();
    } else {
      stats = await fs.statfs(scope, { bigint: true });
    }

    if (!stats) {
      return null;
    }

    if (stats.blocks <= 0n) {
      return null;
    }

    const used = Number((stats.blocks - stats.bfree) * stats.bsize);
    const total = Number(stats.blocks * stats.bsize);
    const free = Number(stats.bavail * stats.bsize);
    const capacity = used + free;

    let usage;

    if (capacity > 0) {
      usage = (used / capacity) * 100;
    } else {
      usage = 0;
    }

    const result = { usage, used, total, free, virtual };

    return result;
  } catch {
    return null;
  }
}

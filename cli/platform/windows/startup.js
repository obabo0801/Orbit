import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as platform from "#cli/platform/index.js";

export function active(manifest) {
  if (!platform.linux) {
    return false;
  }

  const bridged = process.env.ORBIT_WINDOWS === "1";
  const recorded = Boolean(manifest.windows);
  const valid = bridged || recorded;

  return valid;
}

async function run(action, manifest) {
  const directory = "/mnt/c/Windows/System32";
  const program = directory + "/WindowsPowerShell/v1.0/powershell.exe";
  const script = path.local("./startup.ps1", import.meta.url);
  const converting = await command.run("/usr/bin/wslpath", ["-w", script]);
  const filename = converting.output.trim();
  const name = manifest.windows?.distribution ?? process.env.WSL_DISTRO_NAME;

  if (!name) {
    throw new Error("STARTUP_IDENTITY: Ubuntu owner identity is unavailable.");
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    filename,
    "-Action",
    action,
    "-Distribution",
    name,
  ];

  const node = manifest.tools.node;
  const boot = path.file("cli", "boot.js");

  args.push("-Node", node, "-Entry", boot);

  const option = { timeout: 120000 };
  const report = await command.run(program, args, option);

  return JSON.parse(report.output.trim());
}

export async function prepare(manifest) {
  if (!active(manifest)) {
    return;
  }

  try {
    const value = await run("prepare", manifest);

    manifest.windows = value;

    await store.write(manifest);
  } catch (failure) {
    try {
      const value = await run("inspect", manifest);

      manifest.windows = value;

      await store.write(manifest);
    } catch {
      throw failure;
    }

    throw failure;
  }
}

export async function set(manifest, enabled) {
  if (!active(manifest)) {
    return;
  }

  if (!manifest.windows) {
    await prepare(manifest);
  }

  let action;

  if (enabled) {
    action = "enable";
  } else {
    action = "disable";
  }

  const value = await run(action, manifest);

  manifest.windows = value;

  await store.write(manifest);
}

export async function remove(manifest) {
  if (!manifest.windows) {
    return;
  }

  await run("remove", manifest);

  delete manifest.windows;

  await store.write(manifest);
}

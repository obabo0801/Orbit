import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";

export async function prepare(name, script, option = {}) {
  const execute = option.command ?? command;
  const prefix = ["--distribution", name, "--exec"];
  const probe = [...prefix, "/bin/sh", script, "--probe", path.init];
  const setting = { allow: true };
  const ready = await execute.run("wsl.exe", probe, setting);

  if (ready.code === 0) {
    return;
  }

  const permission = [...prefix, "/usr/bin/sudo", "-v"];
  const authorized = await execute.terminal("wsl.exe", permission);

  if (authorized !== 0) {
    throw error("permission");
  }

  const args = [
    ...prefix,
    "/usr/bin/sudo",
    "-n",
    "--",
    "/bin/sh",
    script,
    "--prepare",
    path.integration.config,
  ];

  const prepared = await execute.terminal("wsl.exe", args);

  if (prepared !== 0) {
    throw error("preparation");
  }

  const restart = ["--terminate", name];

  await execute.run("wsl.exe", restart);

  const active = await execute.run("wsl.exe", probe, setting);

  if (active.code !== 0) {
    throw error("preparation", { reason: "init" });
  }
}

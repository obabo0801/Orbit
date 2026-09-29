import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import { error } from "#cli/core/error.js";
import * as store from "#cli/core/manifest.js";

export async function environment() {
  const manager = await fs.readFile(path.init, "utf8").catch((failure) => {
    if (failure.code === "ENOENT") {
      return "";
    }

    throw failure;
  });

  let diagnostic = "";

  if (manager.trim() === "systemd") {
    try {
      const args = ["show", "--property=Version"];
      const option = { allow: true };
      const report = await command.run("/usr/bin/systemctl", args, option);

      if (report.code === 0) {
        return;
      }

      diagnostic = report.diagnostic;
    } catch (failure) {
      diagnostic = failure.diagnostic ?? failure.message;
    }
  }

  const failure = error("system", { reason: "init" });

  failure.diagnostic = diagnostic;

  throw failure;
}

export async function create(name) {
  const args = [
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    "/nonexistent",
    "--shell",
    "/usr/sbin/nologin",
    name,
  ];

  await command.run("/usr/sbin/useradd", args);
}

export async function group(name) {
  const args = ["group", name];
  const option = { allow: true };
  const report = await command.run("/usr/bin/getent", args, option);

  let result;

  if (report.code === 0) {
    result = Number(report.output.trim().split(":")[2]);
  } else {
    result = null;
  }

  return result;
}

export async function remove(name) {
  await command.run("/usr/sbin/userdel", [name]);
}

export async function ungroup(name) {
  await command.run("/usr/sbin/groupdel", [name]);
}

export async function tools() {
  for (const binary of ["/usr/sbin/useradd", "/usr/sbin/runuser"]) {
    if (!(await store.exists(binary))) {
      throw error("dependencies");
    }
  }
}

export async function user(name, program, args, option = {}) {
  const values = ["-u", name, "--", program, ...args];

  return await command.run("/usr/sbin/runuser", values, option);
}

export async function mounts() {
  const text = await fs.readFile(path.mounts, "utf8");

  const result = text.split("\n").map((line) => {
    const value = (line.split(" ")[4] ?? "").replace(
      /\\([0-7]{3})/g,
      (match, digits) => {
        const decoded = String.fromCharCode(parseInt(digits, 8));

        return decoded;
      },
    );

    return value;
  });

  return result;
}

export async function sockets() {
  return await command.run("/usr/bin/ss", ["-H", "-lntup"]);
}

export async function processes() {
  const args = ["-eo", "pid=,args="];

  return await command.run("/usr/bin/ps", args);
}

export const locale = "C.UTF-8";

export async function layout() {}

export async function prepare() {}

export async function finish() {}

export async function sync(directory) {
  await directory.sync();
}

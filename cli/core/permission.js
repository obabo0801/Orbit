import * as platform from "#cli/platform/index.js";
import * as wsl from "#cli/core/wsl.js";
import * as path from "#cli/core/path.js";
import { randomUUID } from "node:crypto";
import * as command from "#cli/core/process.js";
import * as input from "#cli/view/input.js";
import { install as core } from "#cli/core/install.js";
import { error } from "#cli/core/error.js";
import * as locale from "#cli/core/locale.js";
import * as wizard from "#cli/view/wizard.js";
import * as progress from "#cli/view/progress.js";
import * as removal from "#cli/core/uninstall.js";
import * as placement from "#cli/view/storage.js";
import * as storage from "#cli/core/storage.js";

export async function distribution(option = {}) {
  const execute = option.command ?? command;
  const listing = ["--list", "--verbose"];
  const settings = { encoding: "utf16le" };

  let report;

  try {
    report = await execute.run("wsl.exe", listing, settings);
  } catch {
    throw error("distribution");
  }

  const entries = report.output.split(/\r?\n/).flatMap(function entry(line) {
    const match = line.match(/^\s*\*?\s*(.+?)\s+\S+\s+(\d+)\s*$/u);

    if (!match) {
      const result = [];

      return result;
    }

    const name = match[1];
    const version = Number(match[2]);
    const output = [{ name, version }];

    return output;
  });

  const requested = option.name ?? process.env.ORBIT_WSL;

  const candidates = entries.filter(function candidate(entry) {
    let named;

    if (requested) {
      named = entry.name === requested;
    } else {
      named = /^Ubuntu(?:$|[-\s])/i.test(entry.name);
    }

    let version;

    if (named) {
      version = entry.version === 2;
    }

    const result = named && version;

    return result;
  });

  if (candidates.length !== 1) {
    throw error("distribution");
  }

  const name = candidates[0].name;

  const args = [
    "--distribution",
    name,
    "--exec",
    "/bin/cat",
    "/etc/os-release",
  ];

  const system = await execute.run("wsl.exe", args);

  if (!/^ID=ubuntu$/m.test(system.output)) {
    throw error("distribution");
  }

  return name;
}

async function convert(name, filename, option = {}) {
  const execute = option.command ?? command;

  if (filename.startsWith("/")) {
    return filename;
  }

  if (!path.absolute(filename)) {
    throw error("plan", { reason: "absolute" });
  }

  const args = [
    "--distribution",
    name,
    "--exec",
    "/usr/bin/wslpath",
    "-u",
    filename,
  ];

  const report = await execute.run("wsl.exe", args);

  return report.output.trim();
}

export async function bridge(option = {}) {
  await locale.native();

  const preference = option.language ?? "auto";

  const language = locale.resolve(
    { language: preference },
    { platform: "win32" },
  );

  const stream = process.stdout;

  let capable = stream.isTTY;

  if (capable) {
    capable = stream.hasColors?.(16777216) === true;
  }

  let colors;

  if (capable) {
    colors = "24";
  } else if (stream.hasColors?.(8)) {
    colors = "8";
  } else {
    colors = "0";
  }

  const values = [
    `ORBIT_LOCALE=${language}`,
    `ORBIT_COLORS=${colors}`,
    "ORBIT_WINDOWS=1",
  ];

  if (capable) {
    values.push("COLORTERM=truecolor");
  }

  if (process.env.NO_COLOR !== undefined) {
    values.push(`NO_COLOR=${process.env.NO_COLOR}`);
  }

  if (process.env.TERM) {
    values.push(`TERM=${process.env.TERM}`);
  }

  return values;
}

async function windows(filename, language, option = {}) {
  const name = await distribution({ name: option.name });

  let plan;

  if (filename) {
    plan = await convert(name, filename);
  } else {
    plan = undefined;
  }

  const source = path.entry;
  const entry = await convert(name, source);

  let node;

  if (plan) {
    const reading = ["--distribution", name, "--exec", "/bin/cat", plan];
    const option = { allow: true };
    const contents = await command.run("wsl.exe", reading, option);

    if (contents.code !== 0) {
      node = undefined;
    } else {
      let settings;

      try {
        settings = JSON.parse(contents.output);
      } catch {
        throw error("plan", { reason: "document" });
      }

      let object = settings !== null;

      if (object) {
        object = typeof settings === "object";
      }

      if (!object) {
        throw error("plan", { reason: "document" });
      }

      node = settings.node;
    }
  }

  const script = await convert(name, path.integration.script);

  await wsl.prepare(name, script);

  node = await bootstrap(name, { node });

  const selected = locale.resolve({ language });

  let region;

  if (selected === "ko") {
    region = "ko_KR.UTF-8";
  } else {
    region = "en_US.UTF-8";
  }

  const environment = [
    "-u",
    "ORBIT_HOME",
    "-u",
    "ORBIT_SYSTEM",
    "-u",
    "ORBIT_PLAN",
    `LC_ALL=${region}`,
  ];

  environment.push(...(await bridge({ language })));

  const args = [
    "--distribution",
    name,
    "--exec",
    "/usr/bin/env",
    ...environment,
    node,
    entry,
    "install",
  ];

  if (plan) {
    args.push(plan);
  }

  const code = await command.terminal("wsl.exe", args);
  const result = { code, dashboard: code === 0 };

  return result;
}

async function bootstrap(name, option = {}) {
  const execute = option.command ?? command;

  let supplied = typeof option.node === "string";

  if (supplied) {
    supplied = option.node.startsWith("/");
  }

  let candidates;

  if (supplied) {
    candidates = [option.node, ...path.nodes];
  } else {
    candidates = path.nodes;
  }

  const script = await convert(name, path.bootstrap, option);

  const args = [
    "--distribution",
    name,
    "--exec",
    "/bin/sh",
    script,
    path.runtime,
    "--probe",
    ...candidates,
  ];

  const setting = { allow: true };
  const report = await execute.run("wsl.exe", args, setting);

  if (report.code !== 0) {
    const token = randomUUID();
    const target = `node.${token}`;

    const preparing = [
      "--distribution",
      name,
      "--exec",
      "/usr/bin/sudo",
      "--",
      "/bin/sh",
      script,
      path.runtime,
      "--target",
      target,
    ];

    const code = await execute.terminal("wsl.exe", preparing);

    if (code !== 0) {
      throw error("dependencies", { reason: "executable", target: "Node.js" });
    }

    return path.child(path.runtime, target, "tool/bin/node");
  }

  return report.output.trim();
}

async function elevate(filename) {
  const entry = path.entry;
  const check = await command.terminal("/usr/bin/sudo", ["-v"]);

  if (check !== 0) {
    throw error("permission");
  }

  const args = ["-n", "--"];
  const bridged = process.env.ORBIT_WINDOWS === "1";

  if (bridged) {
    args.push("/usr/bin/env", "ORBIT_WINDOWS=1");

    const name = process.env.WSL_DISTRO_NAME;

    if (name) {
      args.push(`WSL_DISTRO_NAME=${name}`);
    }
  }

  args.push(process.execPath, entry, "install");

  if (filename) {
    args.push(filename);
  }

  const code = await command.terminal("/usr/bin/sudo", args);
  const result = { code, dashboard: code === 0 };

  return result;
}

export async function install(filename, language = "auto") {
  let valid = platform.native;

  if (valid) {
    valid = process.getuid?.() === 0;
  }

  if (valid) {
    const previous = process.env.ORBIT_SYSTEM;
    const display = await progress.open(language);

    process.env.ORBIT_SYSTEM = "1";

    async function ask(field) {
      display.pause();

      try {
        return await wizard.ask(field, { language });
      } finally {
        display.resume();
      }
    }

    const option = { ask, progress: display.update };

    try {
      return await core(filename, option);
    } finally {
      display.close();

      if (previous === undefined) {
        delete process.env.ORBIT_SYSTEM;
      } else {
        process.env.ORBIT_SYSTEM = previous;
      }
    }
  }

  let selection;

  if (process.platform === "win32") {
    selection = await placement.select(language);

    if (!selection) {
      const value = { code: 0, cancelled: true };

      return value;
    }
  }

  const interactive = input.active();

  if (interactive) {
    input.close();
  }

  try {
    if (platform.linux) {
      let report = filename;

      if (report) {
        report = !path.absolute(filename);
      }

      if (report) {
        throw error("plan", { reason: "absolute" });
      }

      return await elevate(filename);
    } else if (platform.windows) {
      const name = await storage.prepare(selection);

      return await windows(filename, language, { name });
    } else if (platform.mac) {
      let complete = filename;

      if (complete) {
        complete = !path.absolute(filename);
      }

      if (complete) {
        throw error("plan", { reason: "absolute" });
      }

      return await elevate(filename);
    }

    throw error("unsupported");
  } finally {
    if (interactive) {
      input.open();
    }
  }
}

export async function uninstall(all = false, option = {}) {
  let unconfirmed = all;

  if (unconfirmed) {
    unconfirmed = !option.confirmed;
  }

  if (unconfirmed) {
    throw error("confirmation");
  }

  const language = option.language ?? "auto";
  const setting = { operation: "uninstall" };
  const display = await progress.open(language, setting);
  const settings = { confirmed: option.confirmed, progress: display.update };

  try {
    return await removal.uninstall(all, settings);
  } finally {
    display.close();
  }
}

export async function runtime(operation, option = {}) {
  const platform = option.platform ?? process.platform;
  const execute = option.command ?? command;

  if (process.env.ORBIT_HOME) {
    return null;
  }

  let unprivileged = path.system();

  if (unprivileged) {
    unprivileged = process.getuid?.() !== 0;
  }

  async function elevate() {
    const args = [
      "--",
      process.execPath,
      path.entry,
      operation,
      "--system",
      ...process.argv.slice(3),
    ];

    return execute.terminal("/usr/bin/sudo", args);
  }

  if (platform === "linux") {
    if (unprivileged) {
      return elevate();
    }

    return null;
  }

  if (platform === "win32") {
    let name;

    try {
      name = await distribution(option);
    } catch (failure) {
      if (process.env.ORBIT_WSL) {
        throw failure;
      }

      if (failure.code === "distribution") {
        return null;
      }

      throw failure;
    }

    const prefix = ["--distribution", name, "--exec"];
    const probe = [...prefix, "/usr/bin/test", "-f", path.installation];
    const setting = { allow: true };
    const report = await execute.run("wsl.exe", probe, setting);

    if (report.code === 1) {
      return null;
    }

    if (report.code !== 0) {
      throw error("installation");
    }

    const script = await convert(name, path.integration.script, option);

    await wsl.prepare(name, script, option);

    const node = await bootstrap(name, option);
    const entry = await convert(name, path.entry, option);

    const args = [
      ...prefix,
      "/usr/bin/sudo",
      "--",
      "/usr/bin/env",
      "-u",
      "ORBIT_HOME",
      "-u",
      "ORBIT_PLAN",
      "ORBIT_SYSTEM=1",
    ];

    args.push(...(await bridge()));

    const parameters = process.argv.slice(3);

    if (operation === "update") {
      const index = parameters.indexOf("--checkout");
      const specified = index >= 0;

      if (specified) {
        const filename = parameters[index + 1];
        const windows = /^[a-z]:[\\/]/iu.test(filename ?? "");

        if (windows) {
          parameters[index + 1] = await convert(name, filename, option);
        }
      }
    }

    args.push(node, entry, operation, "--system", ...parameters);

    return execute.terminal("wsl.exe", args);
  }

  if (platform === "darwin") {
    if (unprivileged) {
      return elevate();
    }
  }

  return null;
}

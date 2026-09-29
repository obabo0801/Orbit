import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";
import * as store from "#cli/core/manifest.js";
import * as availability from "#cli/core/availability.js";
import * as identity from "#cli/core/unit.js";
import * as primary from "#cli/core/primary.js";
import * as fs from "node:fs/promises";

export { units, unit } from "#cli/core/unit.js";

const { units, unit } = identity;

export async function listener(port) {
  command.root();

  const report = await command.run(
    "/usr/bin/ss",
    ["-H", "-ltn", "sport = :" + port],
    { timeout: 5000 },
  );

  const result = report.output.trim().length > 0;

  return result;
}

async function owned(filename, entry, details, status) {
  let output = !details?.isFile();

  if (!output) {
    output = !entry?.hash;
  }

  if (output) {
    return false;
  }

  const hash = await store.digest(filename);

  if (hash !== entry.hash) {
    return false;
  }

  return status.FragmentPath === filename;
}

export async function state(service, option = {}) {
  const properties = [
    "ActiveState",
    "SubState",
    "MainPID",
    "UnitFileState",
    "LoadState",
    "ControlGroup",
    "FragmentPath",
    "ActiveEnterTimestamp",
    "InactiveEnterTimestamp",
  ];

  const property = properties.join(",");
  const argument = `--property=${property}`;
  const args = ["show", unit(service), "--no-pager", argument];
  const env = { TZ: "UTC", LC_ALL: "C" };
  const signal = option.signal;
  const settings = { env, signal };
  const result = await command.run("/usr/bin/systemctl", args, settings);
  const output = result.output.trim();
  const lines = output.split("\n");

  const entries = lines.map(function pair(line) {
    const position = line.indexOf("=");
    const name = line.slice(0, position);
    const value = line.slice(position + 1);
    const result = [name, value];

    return result;
  });

  return Object.fromEntries(entries);
}

async function authorize(service) {
  const filename = path.unit(unit(service));
  const manifest = await store.read();
  const entry = store.entry(manifest, filename);
  const details = await store.exists(filename);
  const status = await state(service);

  let valid = !details;

  if (valid) {
    valid = status.LoadState === "not-found";
  }

  if (valid) {
    return false;
  }

  if (!(await owned(filename, entry, details, status))) {
    throw error("changed");
  }

  return true;
}

export function adapter() {
  if (!path.system()) {
    return undefined;
  }

  const output = {
    async running(service) {
      const report = await state(service);

      let result = [
        "active",
        "activating",
        "deactivating",
        "reloading",
      ].includes(report.ActiveState);

      if (!result) {
        result = Number(report.MainPID) > 0;
      }

      return result;
    },
    async start(service, option = {}) {
      command.root();

      await primary.guard(service.role, option);

      if (!(await authorize(service))) {
        throw error("manifest");
      }

      const options = { timeout: 90000 };
      const args = ["start", unit(service)];

      await command.run("/usr/bin/systemctl", args, options);

      if (service.role !== "MONITOR") {
        await availability.wait(service);
      }
    },
    async stop(service, option = {}) {
      command.root();

      if (!(await authorize(service))) {
        return;
      }

      const signal = option.signal;
      const options = { timeout: 90000, signal };
      const args = ["stop", unit(service)];

      await command.run("/usr/bin/systemctl", args, options);
    },
    async logs(services, option = {}) {
      const args = [
        "--no-pager",
        "--follow",
        "--lines=100",
        "--output=short-iso",
      ];

      if (option.cursor) {
        args.splice(2, 1);

        args.push(`--cursor=${option.cursor}`);

        args.push("--no-tail");

        args[2] = "--output=json";
      }

      for (const service of units(services)) {
        args.push("--unit", unit(service));
      }

      await command.follow("/usr/bin/journalctl", args, option);
    },
  };

  return output;
}

export async function fence(record, service, enabled) {
  command.root();

  const directory = path.unit(unit(service)) + ".d";

  if (!(await store.exists(directory))) {
    await store.directory(record, directory);
  }

  const filename = path.child(directory, "20-orbit-fence.conf");

  const contents = ["[Unit]", "ConditionPathExists=!" + path.blocked, ""].join(
    "\n",
  );

  await primary.write(record, filename, contents, { mode: 0o644 });

  await command.run("/usr/bin/systemctl", ["daemon-reload"]);

  const result = Boolean(await store.exists(path.blocked));

  if (result !== enabled) {
    throw new Error("PROMOTION_FENCE: Database fencing could not be verified.");
  }
}

export async function fenced(record, service) {
  const filename = path.child(
    path.unit(unit(service)) + ".d",
    "20-orbit-fence.conf",
  );

  const entry = store.entry(record, filename);

  if (!entry?.hash) {
    return false;
  }

  const hash = await store.digest(filename);
  const matching = hash === entry.hash;
  const contents = await fs.readFile(filename, "utf8");
  const configured = contents.includes("ConditionPathExists=!" + path.blocked);
  const result = matching && configured;

  return result;
}

export async function startup(manifest, enabled, option = {}) {
  command.root();

  const names = [];

  for (const service of units(option.services ?? manifest.services)) {
    if (await authorize(service)) {
      names.push(unit(service));
    }
  }

  if (names.length) {
    for (const name of names) {
      const filename = path.startup(name);

      let absent;

      if (enabled) {
        absent = !(await store.exists(filename));
      }

      let register = enabled && absent;

      if (register) {
        register = manifest.entries;
      }

      if (register) {
        const target = path.unit(name);

        const entry = {
          path: filename,
          type: "link",
          target,
          done: false,
          keep: false,
        };

        manifest.entries.push(entry);
      }
    }

    if (manifest.entries) {
      await store.write(manifest);
    }

    let action;

    if (enabled) {
      action = "enable";
    } else {
      action = "disable";
    }

    const args = [action, ...names];

    await command.run("/usr/bin/systemctl", args);

    if (manifest.entries) {
      for (const entry of manifest.entries) {
        let value = entry.type === "link";

        if (value) {
          value = entry.path.includes("multi-user.target.wants/");
        }

        if (value) {
          entry.done = Boolean(await store.exists(entry.path));
        }
      }

      await store.write(manifest);
    }
  }
}

export async function validate(services) {
  const files = units(services).map((service) => path.unit(unit(service)));
  const args = ["verify", ...files];

  await command.run("/usr/bin/systemd-analyze", args);
}

export async function reload(services = []) {
  await command.run("/usr/bin/systemctl", ["daemon-reload"]);

  for (const service of units(services)) {
    const args = ["reset-failed", unit(service)];

    await command.run("/usr/bin/systemctl", args, { allow: true });
  }
}

import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import * as template from "#cli/platform/mac/template.js";
import * as logs from "#cli/platform/mac/journal.js";
import { error } from "#cli/core/error.js";
import * as availability from "#cli/core/availability.js";
import { unit } from "#cli/core/unit.js";
import { setTimeout } from "node:timers/promises";
import * as primary from "#cli/core/primary.js";

export async function listener(port) {
  command.root();

  const report = await command.run("/usr/sbin/netstat", ["-an", "-p", "tcp"], {
    timeout: 5000,
    env: { LC_ALL: "C" },
  });

  const expression = "^Proto\\s+Recv-Q\\s+Send-Q\\s+";
  const suffix = "Local Address\\s+Foreign Address";
  const pattern = new RegExp(expression + suffix, "mu");
  const header = pattern.test(report.output);
  const clean = report.diagnostic.trim() === "";
  const valid = header && clean;

  if (!valid) {
    throw new Error("PROMOTION_LISTENER: Unexpected database listener.");
  }

  const rows = report.output.split("\n").filter((line) => {
    return /^tcp[46]*\s/u.test(line.trim());
  });

  const result = rows.some((line) => {
    const fields = line.trim().split(/\s+/u);

    if (fields.length < 6) {
      throw new Error("PROMOTION_LISTENER: Unexpected database listener.");
    }

    const address = fields[3].endsWith("." + port);
    const listening = fields[5] === "LISTEN";
    const matching = address && listening;

    return matching;
  });

  return result;
}

function target(service) {
  unit(service);

  const label = template.label(service.unit);
  const result = "system/" + label;

  return result;
}

export async function state(service, option = {}) {
  const filename = path.unit(service.unit);

  const contents = await fs.readFile(filename, "utf8").catch((failure) => {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  });

  const args = ["print", target(service)];
  const settings = { allow: true, signal: option.signal, env: { LC_ALL: "C" } };
  const result = await command.run("/bin/launchctl", args, settings);
  const text = result.output;
  const identified = Number(text.match(/^\s*pid = (\d+)$/m)?.[1]);
  const empty = 0;
  const supervisor = identified || empty;

  let pid = 0;
  let started = "";

  if (supervisor) {
    const args = ["-axo", "pid=,ppid=,lstart="];
    const report = await command.run("/bin/ps", args, settings);
    const rows = report.output.split("\n");

    for (const row of rows) {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);

      let valid = match;

      if (valid) {
        valid = Number(match[2]) === supervisor;
      }

      if (valid) {
        pid = Number(match[1]);
        started = match[3];

        break;
      }
    }
  }

  const active = pid > 0;

  let stopped;

  if (supervisor) {
    stopped = "activating";
  } else {
    stopped = "inactive";
  }

  let status;

  if (active) {
    status = "active";
  } else {
    status = stopped;
  }

  let substate;

  if (active) {
    substate = "running";
  } else {
    substate = "dead";
  }

  const registered = result.code === 0;
  const installed = contents !== null;
  const present = registered || installed;

  let load;

  if (present) {
    load = "loaded";
  } else {
    load = "not-found";
  }

  const enabled = contents?.includes("<key>RunAtLoad</key><true/>") === true;

  let startup;

  if (enabled) {
    startup = "enabled";
  } else {
    startup = "disabled";
  }

  let group;

  if (supervisor) {
    group = String(supervisor);
  } else {
    group = "";
  }

  const main = String(pid);

  const answer = {
    ActiveState: status,
    SubState: substate,
    MainPID: main,
    UnitFileState: startup,
    LoadState: load,
    ControlGroup: group,
    FragmentPath: filename,
    ActiveEnterTimestamp: started,
    InactiveEnterTimestamp: "",
  };

  return answer;
}

async function owned(service, record) {
  const filename = path.unit(service.unit);

  await store.safe(filename);

  const entry = store.entry(record, filename);

  if (!entry) {
    throw error("manifest");
  }

  const hash = await store.digest(filename);

  if (hash !== entry.hash) {
    throw error("changed");
  }
}

async function stopped(report) {
  const supervisor = Number(report.ControlGroup);
  const group = Number(report.MainPID);
  const args = ["-axo", "pid=,pgid=,stat="];

  for (let attempt = 0; attempt < 600; attempt++) {
    const listing = await command.run("/bin/ps", args);

    const pending = listing.output.split("\n").some(function active(line) {
      const [pid, pgid, state] = line.trim().split(/\s+/);

      let present = Boolean(state);

      if (present) {
        present = !state.startsWith("Z");
      }

      const wrapper = Number(pid) === supervisor;

      let member = group > 0;

      if (member) {
        member = Number(pgid) === group;
      }

      const owned = wrapper || member;
      const pending = present && owned;

      return pending;
    });

    if (!pending) {
      return;
    }

    await setTimeout(100);
  }

  throw error("running");
}

export function adapter() {
  let record;
  let stamp;

  async function verify(service) {
    await store.safe(path.installation);

    const details = await fs.lstat(path.installation);

    const values = [
      details.dev,
      details.ino,
      details.size,
      details.mtimeMs,
      details.ctimeMs,
      details.mode,
      details.uid,
      details.gid,
    ];

    const signature = JSON.stringify(values);

    if (signature !== stamp) {
      record = await store.read();
      stamp = signature;
    }

    await owned(service, record);
  }

  const output = {
    async running(service) {
      const report = await state(service);

      return ["active", "activating"].includes(report.ActiveState);
    },
    async start(service, option = {}) {
      command.root();

      await primary.guard(service.role, option);

      await verify(service);

      const address = target(service);
      const settings = { allow: true };

      const report = await command.run(
        "/bin/launchctl",
        ["print", address],
        settings,
      );

      if (report.code !== 0) {
        const args = ["bootstrap", "system", path.unit(service.unit)];

        await command.run("/bin/launchctl", args);
      }

      await command.run("/bin/launchctl", ["kickstart", address]);

      if (service.role !== "MONITOR") {
        await availability.wait(service);
      }
    },
    async stop(service) {
      command.root();

      await verify(service);

      const address = target(service);
      const settings = { allow: true };
      const status = await state(service);

      const report = await command.run(
        "/bin/launchctl",
        ["print", address],
        settings,
      );

      if (report.code === 0) {
        await command.run("/bin/launchctl", ["bootout", address]);

        await stopped(status);
      }
    },
    async logs(services, option = {}) {
      if (option.source) {
        await command.stream(option.source, option);
      } else {
        await logs.follow(services, option);
      }
    },
  };

  return output;
}

export async function fence(record, service, enabled) {
  command.root();

  await owned(service, record);

  let action;

  if (enabled) {
    action = "disable";
  } else {
    action = "enable";
  }

  await command.run("/bin/launchctl", [action, target(service)]);
}

export async function fenced(record, service) {
  await owned(service, record);

  const report = await command.run("/bin/launchctl", [
    "print-disabled",
    "system",
  ]);

  const label = target(service).split("/").at(-1);

  const pattern = new RegExp(
    '"' + label.replaceAll(".", "\\.") + '"\\s*=>\\s*(?:true|disabled)\\b',
    "u",
  );

  return pattern.test(report.output);
}

export async function startup(manifest, enabled, option = {}) {
  command.root();

  const record = await store.read();

  const recovering = ["removing", "ownership", "residual", "removed"].includes(
    manifest.stage,
  );

  for (const service of option.services ?? manifest.services) {
    if (!service.unit) {
      continue;
    }

    const filename = path.unit(service.unit);

    if (recovering) {
      const present = await store.exists(filename);

      if (!present) {
        continue;
      }
    }

    await owned(service, record);

    const contents = await fs.readFile(filename, "utf8");

    let value;

    if (enabled) {
      value = "<true/>";
    } else {
      value = "<false/>";
    }

    const text = contents.replace(
      /<key>RunAtLoad<\/key><(?:true|false)\/>/,
      "<key>RunAtLoad</key>" + value,
    );

    const entry = store.entry(manifest, filename);
    const temporary = path.adjacent(filename, ".orbit-startup.tmp");

    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o644 });

      await fs.rename(temporary, filename);
    } finally {
      await fs.unlink(temporary).catch((failure) => {
        if (failure.code !== "ENOENT") {
          throw failure;
        }
      });
    }

    entry.hash = await store.digest(filename);

    await store.write(manifest);
  }
}

export async function validate(services) {
  for (const service of services) {
    if (service.unit) {
      const args = ["-lint", path.unit(service.unit)];

      await command.run("/usr/bin/plutil", args);
    }
  }
}

export async function reload(services = []) {
  command.root();

  for (const service of services) {
    if (!service.unit) {
      continue;
    }

    const filename = path.unit(service.unit);

    if (await store.exists(filename)) {
      continue;
    }

    const address = target(service);
    const report = await state(service);

    if (report.LoadState === "not-found") {
      continue;
    }

    await command.run("/bin/launchctl", ["bootout", address]);

    await stopped(report);

    const remaining = await state(service);

    if (remaining.LoadState !== "not-found") {
      throw error("running");
    }
  }
}

import * as platform from "#cli/platform/index.js";
import * as path from "#cli/core/path.js";
import * as settings from "#cli/core/config.js";
import { locale } from "#cli/core/locale.js";
import { execute } from "#cli/core/service.js";
import * as view from "#cli/view/dashboard.js";
import * as input from "#cli/view/input.js";
import { error } from "#cli/core/error.js";
import * as permission from "#cli/core/permission.js";
import * as removal from "#cli/core/uninstall.js";
import * as fs from "node:fs/promises";
import * as network from "#cli/network/config.js";
import * as caddy from "#cli/network/caddy.js";
import * as vercel from "#cli/network/vercel.js";
import * as screen from "#cli/view/screen.js";
import * as logs from "#cli/view/logs.js";
import * as upgrade from "#cli/core/upgrade.js";
import * as backup from "#cli/core/backup.js";
import * as plans from "#cli/core/plan.js";
import * as update from "#cli/view/update.js";

const command = process.argv[2] ?? "start";

const commands = [
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "install",
  "configure",
  "uninstall",
  "network",
  "migrate",
  "backup",
  "restore",
  "update",
];

async function operating() {
  const explicit = process.argv.includes("--system");
  const installation = ["install", "uninstall"].includes(command);

  if (explicit || installation) {
    return true;
  }

  let automatic = platform.native;

  if (automatic) {
    automatic = !process.env.ORBIT_HOME;
  }

  if (!automatic) {
    return false;
  }

  const result = fs.access(path.installation).then(
    function present() {
      return true;
    },
    function absent() {
      return false;
    },
  );

  return result;
}

if (await operating()) {
  process.env.ORBIT_SYSTEM = "1";
}

let translate = await locale({ language: "auto" });

function interrupt() {
  input.stop();
}

process.on("SIGINT", interrupt);

process.on("SIGTERM", interrupt);

async function refresh() {
  process.env.ORBIT_SYSTEM = "1";

  const manifest = await settings.installation();

  if (!manifest) {
    throw error("installation");
  }

  await execute("start", manifest);

  await network.prepare();

  return settings.config();
}

async function reset() {
  delete process.env.ORBIT_SYSTEM;

  return settings.config();
}

async function main() {
  if (!commands.includes(command)) {
    throw error("unsupported");
  }

  if (command === "configure") {
    const filename = process.argv[3] ?? path.plan();

    await plans.configure(filename, process.argv.slice(4));

    return;
  }

  const bridged = [
    "start",
    "stop",
    "restart",
    "status",
    "logs",
    "uninstall",
    "migrate",
    "backup",
    "restore",
    "update",
  ];

  if (bridged.includes(command)) {
    const code = await permission.runtime(command);

    if (code !== null) {
      process.exitCode = code;

      return;
    }
  }

  if (command === "network") {
    const format = process.argv[3];
    const filename = process.argv[4] ?? path.network();

    if (!["caddy", "vercel", "middleware", "bundle"].includes(format)) {
      throw error("network");
    }

    await network.prepare(filename);

    const value = await network.load(filename);

    let text;

    if (format === "caddy") {
      text = caddy.render(value);
    } else if (format === "vercel") {
      text = vercel.render(value);
    } else if (format === "middleware") {
      text = vercel.middleware(value);
    } else {
      text = vercel.bundle(value);
    }

    process.stdout.write(text);

    return;
  }

  let answer = command === "start";

  if (!answer) {
    answer = command === "uninstall";
  }

  if (answer) {
    input.open();
  }

  let manifest;

  if (command === "start") {
    manifest = null;
  } else {
    manifest = await settings.installation();
  }

  let outcome = command === "stop";

  if (outcome) {
    outcome = !manifest;
  }

  if (outcome) {
    return;
  }

  const preferences = await settings.config();

  translate = await locale(preferences);

  if (command === "update") {
    const args = process.argv.slice(3);
    const index = args.indexOf("--checkout");

    let checkout;

    if (index >= 0) {
      checkout = args[index + 1];
    } else {
      checkout = undefined;
    }

    const check = args.includes("--check");

    if (index >= 0) {
      let missing = !checkout;

      if (!missing) {
        missing = checkout.startsWith("--");
      }

      if (missing) {
        throw new Error("UPDATE_CHECKOUT: Specify a checkout path.");
      }
    }

    if (args.includes("--authorize")) {
      const adapter = await import("#cli/platform/mac/update.js");
      const result = await adapter.authorize(checkout ?? path.checkout);

      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      await update.open(preferences, { checkout, check });
    }

    return;
  }

  if (command === "install") {
    const filename = process.argv.slice(3).find(function argument(value) {
      const valid = !value.startsWith("--");

      return valid;
    });

    const plan = filename ?? process.env.ORBIT_PLAN;
    const result = await permission.install(plan, preferences.language);

    if (result === "added") {
      return;
    }

    const completed = ["complete", "skipped"].includes(result);

    if (completed) {
      const interactive = process.stdin.isTTY === true;
      const preferences = await refresh();

      if (interactive) {
        input.open();

        await view.dashboard(preferences, { refresh, reset });
      } else {
        const manifest = await settings.installation();
        const translate = await locale(preferences);

        await view.snapshot(manifest, translate);
      }
    } else if (typeof result === "string") {
      await screen.message(result, translate, command);
    } else {
      process.exitCode = result.code;
    }

    return;
  }

  if (command === "uninstall") {
    const all = process.argv.includes("--all");

    if (all) {
      const paths = await removal.preview();

      screen.clear();

      await screen.warning(translate("erase"));

      for (const filename of paths) {
        console.log(filename);
      }

      const option = { title: "uninstall", append: true };

      await screen.menu(["confirm"], translate, option);

      let returned = !process.stdin.isTTY;

      if (!returned) {
        returned = (await screen.choice(["0", "1"])) !== "1";
      }

      if (returned) {
        return;
      }
    }

    const option = { confirmed: all, language: preferences.language };
    const result = await permission.uninstall(all, option);

    await screen.message(result, translate, command);

    return;
  }

  if (command === "start") {
    input.signal.throwIfAborted();

    await network.prepare();

    input.signal.throwIfAborted();

    await view.dashboard(preferences, { refresh, reset });
  } else if (command === "migrate") {
    const result = await upgrade.database(manifest);

    process.stdout.write(result);
  } else if (["backup", "restore"].includes(command)) {
    const option = { migrate: false };

    await upgrade.database(manifest, option);

    const args = process.argv.slice(3).filter((value) => {
      return value !== "--system";
    });

    const action = args[0] ?? "create";

    let eligible = command === "backup";

    if (eligible) {
      eligible = action === "schedule";
    }

    if (eligible) {
      const enabled = args[1] === "on";
      const disabled = args[1] === "off";

      let selection = !enabled;

      if (selection) {
        selection = !disabled;
      }

      if (selection) {
        throw new Error("BACKUP_CONFIG: Choose on or off.");
      }

      const previous = await backup.prepare(manifest);

      let interval;

      if (args[2]) {
        interval = Number(args[2]);
      } else {
        interval = previous.interval;
      }

      const value = args[3];

      let retention;

      if (value === "none") {
        retention = null;
      } else if (value) {
        retention = Number(value);
      } else {
        retention = previous.retention;
      }

      const policy = { enabled, interval, retention };

      await backup.configure(manifest, policy);

      process.stdout.write(JSON.stringify(policy) + "\n");
    } else {
      let operation;

      if (command === "restore") {
        operation = "restore";
      } else if (action === "create") {
        operation = "backup";
      } else {
        operation = action;
      }

      let id;

      if (command === "restore") {
        id = args[0];
      } else {
        id = args[1];
      }

      const result = await backup.run(manifest, operation, id);

      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } else if (command === "logs") {
    await logs.open(manifest, translate);
  } else if (command === "status") {
    await view.snapshot(manifest, translate);
  } else {
    const result = await execute(command, manifest);

    if (command !== "stop") {
      await screen.message(result, translate, command);
    }
  }
}

try {
  await main();
} catch (failure) {
  const aborted = failure.name === "AbortError";
  const cancelled = input.signal.aborted;
  const interrupted = cancelled && aborted;

  if (!interrupted) {
    let operation;

    if (commands.includes(command)) {
      operation = command;
    } else {
      operation = "operation";
    }

    if (["migrate", "backup", "restore"].includes(command)) {
      const recognized = /^(?:MIGRATION|BACKUP)_/u.test(failure.message);

      let fallback;

      if (command === "migrate") {
        fallback = "MIGRATION_FAILED: Could not complete migration.";
      } else {
        fallback = "BACKUP_FAILED: Operation failed.";
      }

      let message;

      if (recognized) {
        message = failure.message;
      } else {
        message = fallback;
      }

      process.stderr.write(message + "\n");
    } else {
      await screen.failure(failure, translate, operation);
    }

    process.exitCode = 1;
  }
} finally {
  input.close();

  process.removeListener("SIGINT", interrupt);

  process.removeListener("SIGTERM", interrupt);
}

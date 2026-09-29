import * as config from "#cli/core/config.js";
import * as service from "#cli/core/service.js";
import * as health from "#cli/core/health.js";
import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";
import { setTimeout as delay } from "node:timers/promises";

process.env.ORBIT_SYSTEM = "1";

async function ready() {
  const args = ["is-system-running", "--wait"];
  const option = { allow: true, timeout: 60000 };
  const report = await command.run("/usr/bin/systemctl", args, option);
  const state = report.output.trim();
  const running = state === "running";
  const degraded = state === "degraded";
  const valid = running || degraded;

  if (!valid) {
    throw new Error(`BOOT_SYSTEM: systemd state is ${state}.`);
  }
}

async function main() {
  command.root();

  await ready();

  const preferences = await config.config();

  if (!preferences.startup) {
    console.log(JSON.stringify({ state: "disabled" }));

    return;
  }

  const manifest = await config.installation();

  if (!manifest) {
    throw new Error("BOOT_INSTALLATION: Orbit installation is unavailable.");
  }

  await service.execute("start", manifest);

  const selected = manifest.services.filter(function application(value) {
    return ["WAS", "WEB", "DB", "CADDY"].includes(value.role);
  });

  const installed = { ...manifest, services: selected };
  const option = { timeout: 1500 };

  const monitor = manifest.services.find(function observer(value) {
    return value.role === "MONITOR";
  });

  let args;

  if (monitor) {
    args = ["is-active", monitor.unit];
  } else {
    args = [];
  }

  const setting = { allow: true };

  for (let attempt = 0; attempt < 12; attempt++) {
    const reports = await health.health(installed, option);
    const healthy = reports.every(health.up);

    let observed;

    if (monitor) {
      observed = await command.run("/usr/bin/systemctl", args, setting);
    } else {
      observed = null;
    }

    const running = observed?.output.trim() === "active";
    const prepared = healthy && running;

    if (prepared) {
      console.log(JSON.stringify({ state: "ready" }));

      return;
    }

    await delay(1000);
  }

  throw new Error(
    `BOOT_HEALTH: Orbit health is unavailable at ${path.installation}.`,
  );
}

try {
  await main();
} catch (failure) {
  console.error(failure.diagnostic ?? failure.message);

  process.exitCode = 1;
}

import * as config from "#cli/core/config.js";
import * as service from "#cli/core/service.js";
import * as system from "#cli/core/system.js";
import * as command from "#cli/core/process.js";
import * as path from "#cli/core/path.js";

process.env.ORBIT_SYSTEM = "1";

async function main() {
  command.root();

  const manifest = await config.installation();

  if (!manifest) {
    console.log(JSON.stringify({ state: "absent" }));

    return;
  }

  const signal = AbortSignal.timeout(60000);
  const option = { monitor: true, signal };

  await service.execute("stop", manifest, option);

  const units = system.units(manifest.services);

  const pending = units.map(function status(unit) {
    return system.state(unit);
  });

  const reports = await Promise.all(pending);

  const stopped = reports.every(function inactive(report) {
    const state = report.ActiveState === "inactive";
    const failed = report.ActiveState === "failed";
    const quiet = state || failed;
    const exited = Number(report.MainPID) === 0;
    const valid = quiet && exited;

    return valid;
  });

  if (!stopped) {
    throw new Error("SHUTDOWN_SERVICE: Orbit shutdown did not complete.");
  }

  const database = units.some(function database(unit) {
    return unit.role === "DB";
  });

  if (database) {
    const program = path.child(manifest.tools.postgres, "pg_controldata");
    const args = [path.db];
    const env = { LC_ALL: "C" };
    const setting = { env, signal };
    const report = await command.run(program, args, setting);

    const state = report.output.match(
      /^Database cluster state:\s+(.+)$/mu,
    )?.[1];

    const primary = state === "shut down";
    const replica = state === "shut down in recovery";
    const clean = primary || replica;

    if (!clean) {
      throw new Error(
        "SHUTDOWN_DATABASE: Clean database shutdown could not be verified.",
      );
    }
  }

  const values = reports.map(function status(report, index) {
    const unit = units[index].unit;
    const state = report.ActiveState;
    const pid = Number(report.MainPID);
    const result = { unit, state, pid };

    return result;
  });

  console.log(JSON.stringify({ state: "stopped", units: values }));
}

try {
  await main();
} catch (failure) {
  console.error(failure.diagnostic ?? failure.message);

  process.exitCode = 1;
}

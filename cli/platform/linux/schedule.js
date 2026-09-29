import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";

export function render(manifest, interval) {
  const node = JSON.stringify(manifest.tools.node);
  const entry = JSON.stringify(path.file("cli", "backup.js"));

  const service = [
    "[Unit]",
    "Description=Orbit Backup",
    "After=orbit-db.service",
    "PartOf=orbit-db.service",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${node} ${entry}`,
    "Environment=ORBIT_SYSTEM=1",
    "UMask=0077",
    "TimeoutStartSec=360",
    "TimeoutStopSec=30",
    "KillMode=control-group",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
  ].join("\n");

  const timer = [
    "[Unit]",
    "Description=Orbit Backup Schedule",
    "",
    "[Timer]",
    `OnActiveSec=${interval}s`,
    `OnUnitActiveSec=${interval}s`,
    "AccuracySec=1s",
    "Unit=orbit-backup.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  const files = new Map([
    [path.unit("orbit-backup.service"), service],
    [path.unit("orbit-backup.timer"), timer],
  ]);

  return files;
}

export async function stop() {
  const args = ["disable", "--now", "orbit-backup.timer"];

  await command.run("/usr/bin/systemctl", args);

  await command.run("/usr/bin/systemctl", ["stop", "orbit-backup.service"]);
}

export async function start() {
  await command.run("/usr/bin/systemctl", ["daemon-reload"]);

  const args = ["enable", "--now", "orbit-backup.timer"];

  await command.run("/usr/bin/systemctl", args);
}

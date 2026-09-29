import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";

function escaped(value) {
  const result = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  return result;
}

export function render(manifest, interval) {
  const node = escaped(manifest.tools.node);
  const entry = escaped(path.file("cli", "backup.js"));
  const output = escaped(path.journal("backup"));

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>Label</key><string>com.orbit.backup</string>",
    `<key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string></array>`,
    "<key>EnvironmentVariables</key><dict><key>ORBIT_SYSTEM</key><string>1</string></dict>",
    `<key>StartInterval</key><integer>${interval}</integer>`,
    "<key>RunAtLoad</key><false/>",
    "<key>KeepAlive</key><false/>",
    "<key>UserName</key><string>root</string>",
    "<key>Umask</key><integer>63</integer>",
    `<key>StandardOutPath</key><string>${output}</string>`,
    `<key>StandardErrorPath</key><string>${output}</string>`,
    "</dict></plist>",
    "",
  ];

  const contents = lines.join("\n");
  const files = new Map([[path.unit("orbit-backup.service"), contents]]);

  return files;
}

export async function stop() {
  const args = ["bootout", "system/com.orbit.backup"];
  const report = await command.run("/bin/launchctl", args, { allow: true });

  if (report.code !== 0) {
    const check = ["print", "system/com.orbit.backup"];
    const state = await command.run("/bin/launchctl", check, { allow: true });

    if (state.code === 0) {
      throw new Error("BACKUP_SCHEDULE: Could not stop schedule.");
    }
  }
}

export async function start() {
  const filename = path.unit("orbit-backup.service");

  await command.run("/usr/bin/plutil", ["-lint", filename]);

  await command.run("/bin/launchctl", ["enable", "system/com.orbit.backup"]);

  await command.run("/bin/launchctl", ["bootstrap", "system", filename]);
}

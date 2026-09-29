import { posix } from "node:path";

export const linux = process.platform === "linux";

export const windows = process.platform === "win32";

export const mac = process.platform === "darwin";

export const native = linux || mac;

const root = "/Library/Application Support/Orbit";
const source = posix.join(root, "Source");
const home = posix.join(root, "Config");
const runtime = "/private/var/run/orbit";
const storage = posix.join(root, "Data");
const backup = posix.join(root, "Backup");
const units = "/Library/LaunchDaemons";
const log = "/Library/Logs/Orbit";
const machine = posix.join(storage, "server");
const packages = ["/opt/homebrew", "/usr/local"];

const layouts = {
  linux: {
    source: "/opt/orbit",
    home: "/etc/orbit",
    runtime: "/run/orbit",
    storage: "/var/lib/orbit",
    backup: "/var/backups/orbit",
    units: "/etc/systemd/system",
    log: "/var/log/orbit",
    machine: "/etc/machine-id",
    packages: [],
  },
  win32: null,
  darwin: {
    source,
    home,
    runtime,
    storage,
    backup,
    units,
    log,
    machine,
    packages,
  },
};

export function layout(name = process.platform) {
  const result = layouts[name] ?? layouts.linux;

  return result;
}

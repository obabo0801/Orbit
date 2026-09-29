import * as location from "node:path";
import { fileURLToPath } from "node:url";
import { error } from "#cli/core/error.js";
import * as platform from "#cli/platform/index.js";

const posix = location.posix;
const layout = platform.layout();

export const proc = "/proc";

export const init = posix.join(proc, "1/comm");

export const kernel = posix.join(proc, "sys/kernel/osrelease");

export const interop = posix.join("/run", "WSL", "1_interop");

export const boot = posix.join(proc, "sys/kernel/random/boot_id");

export const source = layout.source;

export const checkout = local("../../", import.meta.url);

export const entry = child(checkout, "cli/index.js");

export const home = layout.home;

export const runtime = layout.runtime;

export const intent = posix.join(runtime, "intent.json");

export const preparation = posix.join(runtime, "tools");

export const provisioning = posix.join(source, "tools");

export const bootstrap = local("./bootstrap.sh", import.meta.url);

const setup = local("./wsl.sh", import.meta.url);
const setting = posix.join("/etc", "wsl.conf");

export const integration = { script: setup, config: setting };

export const storage = layout.storage;

export const backup = layout.backup;

export const units = layout.units;

export const enabled = posix.join(units, "multi-user.target.wants");

export const tls = posix.join(home, "tls");

export const db = posix.join(storage, "db");

export const upload = posix.join(storage, "upload");

export const meta = posix.join(storage, "meta.json");

export const installation = posix.join(storage, "installation.json");

export const monitoring = posix.join(storage, "monitor");

export const log = layout.log;

export const history = posix.join(log, "monitor");

export const observer = file("cli", "monitor.js");

export const machine = layout.machine;

export const config = posix.join(home, "cli.json");

export const store = posix.join(runtime, "store");

export const password = posix.join(runtime, "database.password");

export const caddy = proxy();

export const database = posix.join(home, "db.env");

export const administrator = posix.join(home, "db.admin.env");

export const replica = posix.join(home, "replica.env");

export const authentication = posix.join(home, "pg_hba.conf");

export const passfile = posix.join(home, "replica.pass");

export const transition = posix.join(home, "promotion.json");

export const blocked = posix.join(home, "database.block");

export const authority = posix.join(home, "authority.json");

export const failover = posix.join(home, "failover.json");

export const postgres = posix.join(home, "postgresql.conf");

export const was = posix.join(home, "was.env");

export const version = posix.join(db, "PG_VERSION");

export const pid = posix.join(db, "postmaster.pid");

export const identity = posix.join(db, "pg_ident.conf");

export const socket = posix.join(runtime, "db");

export const start = posix.join(source, "start.sh");

export const stop = posix.join(source, "stop.sh");

export const roots = [source, home, storage, backup, runtime, log];

export const data = [db, upload, backup];

function proxy() {
  const binary = posix.join(source, "caddy");
  const data = posix.join(storage, "caddy");
  const state = posix.join(runtime, "caddy");
  const config = posix.join(home, "Caddyfile");
  const result = { binary, data, runtime: state, config };

  return result;
}

export function certificate(role, extension) {
  return posix.join(tls, `${role}.${extension}`);
}

export function temporary(name) {
  return posix.join(runtime, name);
}

export function task(pid) {
  return posix.join(proc, String(pid), "stat");
}

export function environment(pid) {
  return posix.join(proc, String(pid), "environ");
}

export function program(pid) {
  return posix.join(proc, String(pid), "cmdline");
}

export function powershell(root) {
  return posix.join(
    root,
    "Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  );
}

export function ubuntu(drive) {
  if (!/^[A-Z]:$/i.test(drive)) {
    throw error("config");
  }

  return location.win32.join(drive + "\\", "WSL", "Orbit", "Ubuntu");
}

export function drive(filename) {
  const result = location.win32.parse(filename).root.slice(0, 2);

  return result;
}

export function recovery(name) {
  return child(path().runtime, `${name}.recovery.lock`);
}

export function unit(name) {
  let filename;

  if (platform.mac) {
    filename = "com.orbit." + name.slice(6, -8) + ".plist";
  } else {
    filename = name;
  }

  return posix.join(units, filename);
}

export function startup(name) {
  return posix.join(enabled, name);
}

export function folder(name) {
  return posix.join(source, name);
}

export function file(name, filename) {
  const directory = folder(name);

  return posix.join(directory, filename);
}

export function binary(version) {
  let folder;

  if (platform.mac) {
    folder = "postgresql@" + version;
  } else {
    folder = version;
  }

  return posix.join(binaries, folder, "bin");
}

const candidates = layout.packages.map((prefix) => {
  return posix.join(prefix, "opt/node@24/bin/node");
});

export const nodes = [
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/opt/node24/bin/node",
  ...candidates,
];

let binaries = "/usr/lib/postgresql";

if (platform.mac) {
  let position;

  if (process.arch === "arm64") {
    position = 0;
  } else {
    position = 1;
  }

  const prefix = layout.packages[position];

  binaries = posix.join(prefix, "opt");
}

export { binaries };

export function tools(name) {
  const inherited = (process.env.PATH ?? "").split(location.delimiter);

  const native = layout.packages.map((prefix) => {
    return posix.join(prefix, "bin");
  });

  const directories = [parent(process.execPath), ...native, ...inherited];

  const candidates = directories
    .filter(Boolean)
    .map(function candidate(folder) {
      return child(folder, name);
    });

  if (name === "pnpm") {
    const root = parent(parent(process.execPath));

    candidates.unshift(child(root, "lib/node_modules/corepack/dist/pnpm.js"));
  }

  const result = [...new Set(candidates)];

  return result;
}

export function cgroup(name) {
  return control(name, "cgroup.procs");
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function managed(line) {
  const prefix = escape(source + "/");
  const database = escape(db);
  const pattern = new RegExp(`(?:${prefix}|${database}(?:\\s|$))`);

  return pattern.test(line);
}

export function generated(filename) {
  const prefix = escape(source);

  const pattern = new RegExp(
    `^${prefix}/(cli|web|was|db)/node_modules/\\.pnpm-workspace-state-v1\\.json$`,
  );

  return pattern.test(filename);
}

export function child(parent, name) {
  return location.join(parent, name);
}

export function parent(filename) {
  return location.dirname(filename);
}

export function normalized(filename) {
  return location.resolve(filename);
}

export function local(filename, module) {
  const address = new URL(filename, module);

  return fileURLToPath(address);
}

export function adjacent(filename, name) {
  const directory = parent(filename);

  return child(directory, name);
}

export function absolute(filename) {
  return location.isAbsolute(filename);
}

export function network() {
  const filename = adjacent(path().config, "network.json");
  const result = process.env.ORBIT_NETWORK ?? filename;

  return result;
}

export function plan() {
  return child(checkout, "cli/.local/plan.json");
}

export function path() {
  if (system()) {
    const dashboard = temporary("dashboard.lock");
    const service = temporary("service.lock");
    const directory = runtime;

    const result = {
      home,
      runtime,
      config,
      installation,
      dashboard,
      service,
      source,
      backup,
      temporary: directory,
    };

    return result;
  }

  return development();
}

function development() {
  let home = process.env.ORBIT_HOME;
  let valid = home === undefined;

  if (!valid) {
    valid = home === null;
  }

  if (valid) {
    home = local("../.local/", import.meta.url);
  }

  if (!location.isAbsolute(home)) {
    throw error("config");
  }

  const runtime = home;
  const config = child(home, "config.json");
  const installation = child(home, "installation.json");
  const dashboard = child(home, "dashboard.lock");
  const service = child(home, "service.lock");
  const output = { home, runtime, config, installation, dashboard, service };

  return output;
}

export function search(program, env) {
  const names = Object.keys(env);

  const found = names.find(function variable(name) {
    let result;

    if (process.platform === "win32") {
      result = name.toUpperCase() === "PATH";
    } else {
      result = name === "PATH";
    }

    return result;
  });

  const key = found ?? "PATH";
  const inherited = env[key] ?? "";
  const entries = [parent(process.execPath), parent(program)];
  const corepack = program.endsWith("/corepack/dist/pnpm.js");

  if (corepack) {
    entries.push(child(parent(parent(program)), "shims"));
  }

  if (process.platform !== "win32") {
    entries.push("/usr/bin", "/bin");
  }

  const segments = inherited.split(location.delimiter);
  const combined = [...entries, ...segments];
  const unique = [...new Set(combined)];
  const value = unique.join(location.delimiter);
  const output = { key, value };

  return output;
}

export function system() {
  let result = platform.native;

  if (result) {
    result = process.env.ORBIT_SYSTEM === "1";
  }

  return result;
}

export const controls = "/sys/fs/cgroup";

export let root;

if (platform.mac) {
  root = posix.dirname(storage);
} else {
  root = null;
}

export const mounts = posix.join(proc, "self/mountinfo");

export const build = file("web", "dist");

export function control(name, filename) {
  return posix.join(controls, name, filename);
}

export function metrics(pid) {
  return posix.join(proc, String(pid), "smaps_rollup");
}

export const supervisor = file("cli", "platform/mac/runner.js");

export function journal(name) {
  return posix.join(log, name + ".jsonl");
}

import * as platform from "#cli/core/platform.js";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import * as template from "#cli/core/template.js";
import * as system from "#cli/core/system.js";
import { lock } from "#cli/core/lock.js";
import { config } from "#cli/core/config.js";
import { error } from "#cli/core/error.js";
import * as path from "#cli/core/path.js";
import { setTimeout } from "node:timers/promises";
import * as data from "#cli/core/data.js";
import * as plans from "#cli/core/plan.js";
import * as provision from "#cli/core/tools.js";
import * as record from "#cli/core/record.js";
import * as migration from "#cli/core/migration.js";
import * as backup from "#cli/core/backup.js";
import * as instance from "#cli/core/instance.js";
import * as account from "#cli/core/account.js";
import * as primary from "#cli/core/primary.js";
import * as health from "#cli/core/health.js";
import { copy } from "#cli/core/source.js";

async function available(port, option = {}) {
  const address = option.address ?? "127.0.0.1";

  await new Promise(function check(resolve, reject) {
    const server = createServer();

    server.once("error", reject);

    server.listen(port, address, function ready() {
      server.close(resolve);
    });
  });
}

async function owner(filename, name, mode) {
  const { uid, gid } = await identifiers(name);

  await fs.chown(filename, uid, gid);

  await fs.chmod(filename, mode);
}

async function certificate(record, role, option = {}) {
  const key = path.certificate(role, "key");
  const cert = path.certificate(role, "crt");
  const request = path.temporary(`${role}.csr`);
  const extension = path.temporary(`${role}.ext`);

  for (const filename of [key, cert, request, extension]) {
    await store.safe(filename);

    if (await store.exists(filename)) {
      throw error("collision");
    }

    const entry = { path: filename, type: "file", keep: false, done: false };

    record.entries.push(entry);
  }

  await store.write(record);

  const requesting = [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    request,
    "-subj",
    "/CN=localhost",
  ];

  await command.run(record.tools.openssl, requesting);

  await fs.chmod(key, 0o600);

  await extend(extension, option);

  const ca = path.certificate("ca", "crt");
  const authority = path.certificate("ca", "key");
  const bytes = randomBytes(16);
  const token = bytes.toString("hex");
  const serial = "0x" + token;

  const signing = [
    "x509",
    "-req",
    "-in",
    request,
    "-CA",
    ca,
    "-CAkey",
    authority,
    "-set_serial",
    serial,
    "-out",
    cert,
    "-days",
    "365",
    "-extfile",
    extension,
  ];

  await command.run(record.tools.openssl, signing);

  for (const entry of record.entries.filter(function matches(entry) {
    return [key, cert, request, extension].includes(entry.path);
  })) {
    entry.hash = await store.digest(entry.path);
    entry.done = true;
  }

  await store.write(record);

  await owner(key, `orbit${role}`, 0o600);

  await fs.chmod(cert, 0o644);

  await fs.unlink(request);

  await fs.unlink(extension);
}

async function extend(filename, option = {}) {
  const address = option.address ?? "127.0.0.1";
  const addresses = new Set(["127.0.0.1", address]);

  const entries = [...addresses].map(function entry(value) {
    const result = `IP:${value}`;

    return result;
  });

  const names = ["DNS:localhost", ...entries].join(",");
  const lines = [`subjectAltName=${names}`, "extendedKeyUsage=serverAuth", ""];
  const contents = lines.join("\n");
  const options = { flag: "wx", mode: 0o600 };

  await fs.writeFile(filename, contents, options);
}

export async function install(filename, option = {}) {
  command.root();

  const prepared = [];
  const settings = { ...option, prepared };
  const event = { name: "preparation", state: "running" };

  await option.progress?.(event);

  try {
    const temporary = process.execPath.startsWith(path.runtime + "/node.");

    if (temporary) {
      const setting = { prepared };

      await provision.resolve("node", setting);
    }

    return await setup(filename, settings);
  } catch (failure) {
    const event = { state: "failed" };

    await option.progress?.(event);

    throw failure;
  } finally {
    await provision.cleanup(prepared);
  }
}

export function stages(roles) {
  const names = ["preparation", "prepare", "certificates", "source"];

  for (const role of ["db", "was", "caddy"]) {
    if (roles.includes(role)) {
      names.push(role);
    }
  }

  names.push("register");

  return names;
}

async function setup(filename, option) {
  await environment();

  const plan = await plans.load(filename, option);

  if (plan.add === true) {
    return await add(plan, option);
  }

  const tools = await dependencies(plan, option.prepared);
  const settings = await instance.prepare(plan, tools);

  let { node, postgres, caddy: executable } = tools;

  const record = await store.read();

  if (record?.installed) {
    return "skipped";
  }

  if (record) {
    throw error("collision");
  }

  const observer = { role: "MONITOR", unit: "orbit-monitor.service" };
  const monitoring = await system.state(observer);

  if (monitoring.LoadState !== "not-found") {
    throw error("collision");
  }

  const meta = await data.metadata();
  const reuse = Boolean(meta?.cluster);

  let result = reuse;

  if (result) {
    result = !plan.roles.includes("db");
  }

  if (result) {
    throw error("collision");
  }

  if (plan.roles.includes("db")) {
    await data.reuse(postgres);
  }

  let response = meta;

  if (response) {
    response = (await fs.readdir(path.storage)).some(function unknown(name) {
      const valid = !["meta.json", "db", "upload"].includes(name);

      return valid;
    });
  }

  if (response) {
    throw error("collision");
  }

  for (const name of [path.source, path.home, path.storage, path.backup]) {
    await store.safe(name);

    const report = await store.exists(name);

    let resolved;

    if (report) {
      let retained = meta;

      if (retained) {
        retained = [path.storage, path.backup].includes(name);
      }

      resolved = !retained;
    }

    const received = report && resolved;

    if (received) {
      throw error("collision");
    }
  }

  for (const role of plan.roles) {
    if (await store.exists(path.unit(`orbit-${role}.service`))) {
      throw error("collision");
    }

    let kind;

    if (role === "caddy") {
      kind = "CADDY";
    } else {
      kind = role.toUpperCase();
    }

    const unit = `orbit-${role}.service`;
    const service = { role: kind, unit };
    const status = await system.state(service);

    if (status.LoadState !== "not-found") {
      throw error("collision");
    }

    const options = { allow: true };

    const found = await command.run(
      "/usr/bin/id",
      ["-u", `orbit${role}`],
      options,
    );

    if (found.code === 0) {
      throw error("collision");
    }

    const group = await platform.host.group(`orbit${role}`);

    if (group !== null) {
      throw error("collision");
    }
  }

  const ports = { ...settings.ports, ...settings };

  for (const role of plan.roles) {
    let address;

    if (role === "db") {
      address = "127.0.0.1";
    } else {
      address = settings.address;
    }

    await available(ports[role], { address });
  }

  const preferences = await config();

  if (plan.startup !== undefined) {
    preferences.startup = plan.startup;
  }

  const release = await lock("service");

  const manifest = {
    version: 1,
    installed: false,
    validation: true,
    stage: "prepare",
    services: [],
    accounts: [],
    identities: {},
    entries: [],
    tools,
  };

  if (!store.entry(manifest, path.runtime)) {
    const entry = {
      path: path.runtime,
      type: "runtime",
      done: true,
      keep: false,
    };

    manifest.entries.push(entry);
  }

  const names = stages(plan.roles);

  async function step(name, action) {
    const started = { name, state: "running", stages: names };

    await option.progress?.(started);

    await action();

    const finished = { name, state: "complete", stages: names };

    await option.progress?.(finished);
  }

  const ready = { name: "preparation", state: "complete", stages: names };

  try {
    await option.progress?.(ready);

    await step("prepare", async function preparing() {
      await prepare(manifest, meta, plan);

      await provision.commit(manifest, option.prepared);

      ({ node, postgres, caddy: executable } = manifest.tools);
    });

    await step("certificates", () => certificates(manifest, plan, settings));

    await step("source", () => source(manifest, plan, preferences));

    if (plan.roles.includes("db")) {
      await step("db", () => database(manifest, postgres, reuse, ports));
    }

    if (plan.roles.includes("was")) {
      await step("was", () =>
        was(manifest, plan, node, { ...ports, ...settings }),
      );
    }

    if (plan.roles.includes("caddy")) {
      await step("caddy", () =>
        caddy(manifest, executable, { ...ports, ...settings }),
      );
    }

    const registration = { postgres, reuse, ports, preferences };
    const registering = () => register(manifest, plan, registration);

    await step("register", registering);

    return "complete";
  } catch (failure) {
    manifest.stage = `failed:${manifest.stage}`;

    if (await store.exists(path.installation)) {
      await store.write(manifest);
    }

    throw failure;
  } finally {
    await release();
  }
}

async function add(plan, option) {
  const forbidden = plan.roles.includes("db");

  const unknown = plan.roles.some((role) => {
    const invalid = !["was", "caddy"].includes(role);

    return invalid;
  });

  const invalid = forbidden || unknown;

  if (invalid) {
    throw error("plan", { reason: "roles" });
  }

  const release = await lock("service");

  try {
    const manifest = await store.read();

    if (!manifest?.installed) {
      throw error("installation");
    }

    await primary.guard("WAS");

    const tools = await dependencies(plan, option.prepared);
    const settings = await instance.prepare(plan, tools);
    const preferences = await config();
    const ports = { ...settings.ports, ...settings };

    if (plan.startup !== undefined) {
      if (plan.startup !== preferences.startup) {
        throw error("config", { reason: "required" });
      }
    }

    if (!settings.database) {
      if (plan.roles.includes("was")) {
        throw error("config", { reason: "required" });
      }
    }

    const ca = path.certificate("ca", "crt");
    const previous = await fs.readFile(ca, "utf8");
    const supplied = settings.certificates?.["ca.crt"];

    if (supplied !== undefined) {
      if (supplied !== previous) {
        throw error("changed");
      }
    } else {
      await fs.access(path.certificate("ca", "key"));
    }

    const files = [];

    for (const role of plan.roles) {
      const unit = `orbit-${role}.service`;

      const exists = manifest.services.some((service) => {
        return service.unit === unit;
      });

      if (exists) {
        throw error("collision");
      }

      const status = await system.state({ unit });

      if (status.LoadState !== "not-found") {
        throw error("collision");
      }

      files.push(path.unit(unit), path.certificate(role, "crt"));

      files.push(path.certificate(role, "key"));

      await available(settings.ports[role], { address: settings.address });
    }

    if (plan.roles.includes("was")) {
      files.push(path.was, path.folder("was"));
    }

    if (plan.roles.includes("caddy")) {
      files.push(path.caddy.binary, path.caddy.config, path.caddy.data);

      files.push(path.folder("web"));
    }

    for (const filename of files) {
      await store.safe(filename);

      if (await store.exists(filename)) {
        throw error("collision");
      }
    }

    const before = new Set(manifest.services.map((service) => service.name));
    const entries = new Set(manifest.entries.map((entry) => entry.path));
    const identities = {};

    try {
      for (const role of plan.roles) {
        const name = `orbit${role}`;

        await account.create(manifest, name);

        identities[name] = manifest.identities[name];
      }

      await platform.host.prepare(manifest, identities);

      if (!manifest.tools.caddy) {
        if (tools.caddy) {
          manifest.tools.caddy = tools.caddy;
        }
      }

      await provision.commit(manifest, option.prepared, { extend: true });

      if (settings.certificates) {
        const certificates = { ...settings.certificates };

        delete certificates["ca.crt"];

        await signed(manifest, certificates);
      } else {
        for (const role of plan.roles) {
          await certificate(manifest, role, settings);
        }
      }

      await source(manifest, plan, preferences, { add: true });

      if (plan.roles.includes("was")) {
        await was(manifest, plan, manifest.tools.node, ports);
      }

      if (plan.roles.includes("caddy")) {
        const executable = manifest.tools.caddy ?? tools.caddy;

        await caddy(manifest, executable, ports);
      }

      const services = manifest.services.filter((service) => {
        const added = !before.has(service.name);

        return added;
      });

      await system.validate(services);

      await system.reload();

      await system.startup(manifest, preferences.startup, { services });

      const adapter = system.adapter();

      for (const service of system.units(services)) {
        await adapter.start(service);
      }

      const report = await health.health({ services });

      const applications = report.filter((service) => {
        return ["WEB", "WAS"].includes(service.role);
      });

      const ready = applications.every((service) => {
        return service.state === "ready";
      });

      if (!ready) {
        throw error("system");
      }

      manifest.stage = "installed";

      const added = manifest.entries.filter((entry) => {
        const created = !entries.has(entry.path);

        return created;
      });

      await ownership(added);

      await store.write(manifest);

      return "added";
    } catch (failure) {
      manifest.stage = "failed:add";

      const added = manifest.entries.filter((entry) => {
        const created = !entries.has(entry.path);

        return created;
      });

      try {
        await ownership(added);

        await store.write(manifest);
      } catch (cleanup) {
        throw new AggregateError(
          [failure, cleanup],
          "INSTALL_RECORD: Could not preserve additional service ownership.",
          { cause: cleanup },
        );
      }

      throw failure;
    }
  } finally {
    await release();
  }
}

async function signed(manifest, certificates) {
  for (const [name, contents] of Object.entries(certificates)) {
    const filename = path.child(path.tls, name);
    const secret = name.endsWith(".key");

    let mode;

    if (secret) {
      mode = 0o600;
    } else {
      mode = 0o644;
    }

    await store.file(manifest, filename, contents, { mode });

    if (secret) {
      const role = name.slice(0, -4);

      await owner(filename, `orbit${role}`, mode);
    }
  }
}

async function prepare(manifest, meta, plan) {
  await fs.chmod(path.runtime, 0o711);

  if (!(await store.exists(path.storage))) {
    await fs.mkdir(path.storage, { mode: 0o755 });
  }

  if (!store.entry(manifest, path.storage)) {
    const entry = {
      path: path.storage,
      type: "directory",
      done: true,
      keep: false,
    };

    manifest.entries.push(entry);
  }

  await store.write(manifest);

  for (const name of [path.db, path.upload, path.backup]) {
    if (await store.exists(name)) {
      const entry = { path: name, type: "data", keep: true, done: true };

      manifest.entries.push(entry);
    }
  }

  if (meta) {
    await store.marker(manifest);
  }

  await store.write(manifest);

  await store.directory(manifest, path.source);

  if (!(await store.exists(path.home))) {
    await store.directory(manifest, path.home);
  }

  if (!(await store.exists(path.tls))) {
    await store.directory(manifest, path.tls);
  }

  for (const role of plan.roles) {
    await account.create(manifest, `orbit${role}`);
  }

  await platform.host.prepare(manifest, manifest.identities);
}

async function certificates(manifest, plan, option = {}) {
  manifest.stage = "certificate";

  if (option.certificates) {
    await signed(manifest, option.certificates);

    return;
  }

  {
    for (const name of ["ca.key", "ca.crt"]) {
      const filename = path.child(path.tls, name);
      const entry = { path: filename, type: "file", keep: false, done: false };

      manifest.entries.push(entry);
    }

    await store.write(manifest);

    const args = [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.certificate("ca", "key"),
      "-out",
      path.certificate("ca", "crt"),
      "-days",
      "3650",
      "-subj",
      "/CN=Orbit Validation CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ];

    await command.run(manifest.tools.openssl, args);

    await fs.chmod(path.certificate("ca", "key"), 0o600);

    for (const entry of manifest.entries.filter(function ca(entry) {
      let result = entry.path.endsWith("/ca.key");

      if (!result) {
        result = entry.path.endsWith("/ca.crt");
      }

      return result;
    })) {
      entry.done = true;
      entry.hash = await store.digest(entry.path);
    }

    await store.write(manifest);
  }

  for (const role of plan.roles) {
    await certificate(manifest, role, option);
  }
}

async function source(manifest, plan, preferences, option = {}) {
  const { node, pnpm } = manifest.tools;
  const entry = path.file("cli", "index.js");
  const ca = path.certificate("ca", "crt");

  manifest.stage = "source";

  await store.write(manifest);

  const source = path.checkout;
  const packages = [];

  if (!option.add) {
    packages.push("cli");
  }

  if (plan.roles.includes("caddy")) {
    packages.push("web");
  }

  if (plan.roles.includes("was")) {
    packages.push("was");
  }

  if (plan.roles.includes("db")) {
    packages.push("db");
  }

  for (const name of packages) {
    await copy(manifest, path.child(source, name), path.folder(name));
  }

  const starting = [
    "#!/bin/sh",
    "export ORBIT_SYSTEM=1",
    `export NODE_EXTRA_CA_CERTS="${ca}"`,
    `exec "${node}" "${entry}" start "$@"`,
    "",
  ];

  const start = starting.join("\n");

  if (!option.add) {
    await store.file(manifest, path.start, start, { mode: 0o755 });
  }

  const stopping = [
    "#!/bin/sh",
    "export ORBIT_SYSTEM=1",
    `export NODE_EXTRA_CA_CERTS="${ca}"`,
    `exec "${node}" "${entry}" stop "$@"`,
    "",
  ];

  const stop = stopping.join("\n");

  if (!option.add) {
    await store.file(manifest, path.stop, stop, { mode: 0o755 });
  }

  for (const name of packages) {
    manifest.stage = `package:${name}`;

    await store.write(manifest);

    try {
      if (!(await store.exists(path.store))) {
        const options = { data: true, mode: 0o700 };

        await store.directory(manifest, path.store, options);
      }

      const cwd = path.folder(name);
      const settings = { cwd, timeout: 300000 };
      const args = ["install", "--frozen-lockfile"];

      if (name !== "web") {
        args.push("--prod");
      }

      args.push("--store-dir", path.store);

      await command.run(pnpm, args, settings);

      if (name === "web") {
        if (plan.build) {
          await copy(manifest, plan.build, path.file("web", "dist"));
        } else {
          const build = { cwd, timeout: 120000 };

          await command.run(pnpm, ["build"], build);
        }
      }
    } finally {
      await store.inventory(manifest, path.folder(name));
    }
  }

  if (!(await store.exists(path.config))) {
    const contents = JSON.stringify(preferences) + "\n";

    await store.file(manifest, path.config, contents, { mode: 0o600 });
  }
}

async function database(manifest, postgres, reuse, ports) {
  const ca = path.certificate("ca", "crt");
  const certificate = path.certificate("db", "crt");
  const key = path.certificate("db", "key");

  manifest.stage = "database";

  await store.write(manifest);

  const bytes = randomBytes(32);
  const password = bytes.toString("hex");
  const entropy = randomBytes(32);
  const administrator = entropy.toString("hex");

  if (!reuse) {
    const options = { data: true, keep: true, mode: 0o700 };

    await store.directory(manifest, path.db, options);

    await owner(path.db, "orbitdb", 0o700);

    const contents = administrator + "\n";

    await store.file(manifest, path.password, contents, { mode: 0o600 });

    await owner(path.password, "orbitdb", 0o600);

    await fs.chmod(path.runtime, 0o711);

    const args = [
      "-u",
      "orbitdb",
      "--",
      path.child(postgres, "initdb"),
      "-D",
      path.db,
      "--username=orbitadmin",
      `--pwfile=${path.password}`,
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--locale=" + platform.host.locale,
    ];

    const settings = { timeout: 120000 };

    await platform.host.user("orbitdb", args[3], args.slice(4), settings);

    await fs.unlink(path.password);
  } else {
    await data.stopped(manifest);

    await data.reuse(postgres);

    const identity = manifest.identities.orbitdb;

    manifest.stage = "ownership";

    await store.write(manifest);

    const owners = [0];
    const setting = { uid: identity.uid, gid: identity.gid, owners };

    await data.ownership([path.db], setting);
  }

  const directories = path.path();

  const variables = [
    "DB_ENABLED=true",
    "DB_HOST=127.0.0.1",
    `DB_PORT=${ports.db}`,
    "DB_NAME=orbit",
    "DB_USER=orbit",
    `DB_PASSWORD=${password}`,
    "DB_SSL=true",
    `DB_CA=${ca}`,
    `DB_BACKUP_PATH=${directories.backup}`,
    `DB_TEMPORARY_PATH=${directories.temporary}`,
    "",
  ];

  const environment = variables.join("\n");

  await store.file(manifest, path.database, environment, { mode: 0o600 });

  const login = ["PGUSER=orbitadmin", `PGPASSWORD=${administrator}`, ""];
  const credentials = login.join("\n");

  await store.file(manifest, path.administrator, credentials, { mode: 0o600 });

  const settings = [
    `data_directory='${path.db}'`,
    `hba_file='${path.authentication}'`,
    `ident_file='${path.identity}'`,
    "listen_addresses='127.0.0.1'",
    `port=${ports.db}`,
    `unix_socket_directories='${path.socket}'`,
    "ssl=on",
    `ssl_cert_file='${certificate}'`,
    `ssl_key_file='${key}'`,
    "password_encryption='scram-sha-256'",
    "logging_collector=off",
    "log_destination='stderr'",
    "",
  ];

  const configuration = settings.join("\n");

  await store.file(manifest, path.postgres, configuration, {});

  const lines = [
    "local all all scram-sha-256",
    "hostssl all all 127.0.0.1/32 scram-sha-256",
    "host all all 0.0.0.0/0 reject",
    "host all all ::0/0 reject",
    "",
  ];

  const rules = lines.join("\n");

  await store.file(manifest, path.authentication, rules, {});

  if (reuse) {
    manifest.stage = "credentials";

    await store.write(manifest);

    const args = [
      "-u",
      "orbitdb",
      "--",
      path.child(postgres, "postgres"),
      "--single",
      "-D",
      path.db,
      "-c",
      `config_file=${path.postgres}`,
      "-c",
      "log_statement=none",
      "-c",
      "log_min_error_statement=panic",
      "postgres",
    ];

    const statements = [
      `ALTER ROLE orbitadmin LOGIN PASSWORD '${administrator}';`,
      `ALTER ROLE orbit LOGIN PASSWORD '${password}';`,
      "",
    ];

    const input = statements.join("\n");
    const settings = { input, timeout: 60000 };

    const reset = await platform.host.user(
      "orbitdb",
      args[3],
      args.slice(4),
      settings,
    );

    if (/\b(ERROR|FATAL|PANIC):/.test(reset.output + reset.diagnostic)) {
      throw error("data");
    }

    await data.reuse(postgres);
  }

  const unit = template.service("db", path.child(postgres, "postgres"), {
    node: manifest.tools.node,
  });

  await store.file(manifest, path.unit("orbit-db.service"), unit);

  const port = ports.db;

  const entry = {
    name: `DB${ports.numbers.db}`,
    role: "DB",
    unit: "orbit-db.service",
    address: "127.0.0.1:55432",
    port,
  };

  manifest.services.push(entry);

  await store.write(manifest);
}

async function was(manifest, plan, node, ports) {
  const certificate = path.certificate("was", "crt");
  const key = path.certificate("was", "key");

  let database;

  if (plan.roles.includes("db")) {
    database = await fs.readFile(path.database, "utf8");
  } else {
    database = ports.database ?? "DB_ENABLED=false\n";
  }

  const lines = [
    `WAS_HOST=${ports.address}`,
    `WAS_PORT=${ports.was}`,
    `WAS_CERT=${certificate}`,
    `WAS_KEY=${key}`,
    `${database}`,
  ];

  const contents = lines.join("\n");

  await store.file(manifest, path.was, contents, { mode: 0o600 });

  await owner(path.was, "orbitwas", 0o600);

  const unit = template.service("was", node, { node });

  await store.file(manifest, path.unit("orbit-was.service"), unit);

  const port = ports.was;

  const entry = {
    name: `WAS${ports.numbers.was}`,
    role: "WAS",
    unit: "orbit-was.service",
    address: `https://${ports.address}:${ports.was}`,
    port,
  };

  manifest.services.push(entry);

  await store.write(manifest);
}

async function caddy(manifest, executable, ports) {
  const binary = await fs.readFile(executable);

  await store.file(manifest, path.caddy.binary, binary, { mode: 0o755 });

  await store.directory(manifest, path.caddy.data, { data: true, mode: 0o700 });

  await owner(path.caddy.data, "orbitcaddy", 0o700);

  const configuration = template.caddy(ports.caddy, ports);

  await store.file(manifest, path.caddy.config, configuration);

  const XDG_DATA_HOME = path.caddy.data;
  const XDG_CONFIG_HOME = path.caddy.runtime;
  const env = { XDG_DATA_HOME, XDG_CONFIG_HOME };
  const settings = { env };

  const args = [
    "validate",
    "--config",
    path.caddy.config,
    "--adapter",
    "caddyfile",
  ];

  await command.run(executable, args, settings);

  const setting = { node: manifest.tools.node };
  const unit = template.service("caddy", path.caddy.binary, setting);

  await store.file(manifest, path.unit("orbit-caddy.service"), unit);

  const port = ports.caddy;

  let requested;

  if (ports.address === "127.0.0.1") {
    requested = "";
  } else {
    requested = `https://${ports.address}:${port}`;
  }

  const entry = {
    name: "Caddy",
    role: "CADDY",
    unit: "orbit-caddy.service",
    address: requested,
    port,
  };

  manifest.services.push(entry);

  let hostname;

  if (ports.address === "127.0.0.1") {
    hostname = "localhost";
  } else {
    hostname = ports.address;
  }

  const item = {
    name: `WEB${ports.numbers.caddy}`,
    role: "WEB",
    address: `https://${hostname}:${ports.caddy}`,
  };

  manifest.services.push(item);

  await store.write(manifest);
}

async function identifiers(name) {
  const user = await command.run("/usr/bin/id", ["-u", name]);
  const uid = Number(user.output.trim());
  const group = await command.run("/usr/bin/id", ["-g", name]);
  const gid = Number(group.output.trim());
  const result = { uid, gid };

  return result;
}

async function environment() {
  await platform.host.environment();

  await platform.host.layout();
}

async function dependencies(plan, prepared) {
  const node = plan.node ?? process.execPath;
  const pnpm = plan.pnpm;
  const postgres = plan.postgres;
  const executable = plan.caddy;
  const binaries = [node, pnpm];

  if (plan.roles.includes("db")) {
    let database = postgres;

    if (database) {
      database = path.child(postgres, "postgres");
    }

    binaries.push(database);
  }

  if (plan.roles.includes("caddy")) {
    binaries.push(executable);
  }

  for (const binary of binaries) {
    if (!(await plans.usable(binary))) {
      throw error("dependencies", { reason: "executable", target: binary });
    }
  }

  const version = await command.run(node, ["--version"]);
  const text = version.output.trim();
  const number = text.slice(1);
  const major = Number(number.split(".")[0]);

  if (major < 24) {
    throw error("dependencies", { reason: "version" });
  }

  const option = { prepared };
  const openssl = await provision.resolve("openssl", option);

  await platform.host.tools();

  const result = { node, pnpm, postgres, caddy: executable, openssl };

  return result;
}

async function register(manifest, plan, option) {
  const { postgres, reuse, ports, preferences } = option;

  manifest.stage = "register";

  await store.write(manifest);

  await record.register(manifest, manifest.tools.node);

  await system.validate(manifest.services);

  await system.reload();

  let valid = plan.roles.includes("db");

  if (valid) {
    valid = !reuse;
  }

  if (valid) {
    const service = { role: "DB", unit: "orbit-db.service", port: ports.db };
    const adapter = system.adapter();

    await adapter.start(service);

    try {
      const database = await fs.readFile(path.database, "utf8");
      const password = database.match(/^DB_PASSWORD=(.+)$/m)[1];

      const administrator = (
        await fs.readFile(path.administrator, "utf8")
      ).match(/^PGPASSWORD=(.+)$/m)[1];

      let ready = false;

      for (let attempt = 0; attempt < 50; attempt++) {
        const report = await command.run(
          path.child(postgres, "pg_isready"),
          ["-h", "127.0.0.1", "-p", String(ports.db)],
          { allow: true },
        );

        if (report.code === 0) {
          ready = true;

          break;
        }

        await setTimeout(200);
      }

      if (!ready) {
        throw error("system");
      }

      const args = [
        "-h",
        "127.0.0.1",
        "-p",
        String(ports.db),
        "-U",
        "orbitadmin",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ];

      const statements = [
        `CREATE ROLE orbit LOGIN PASSWORD '${password}';`,
        "CREATE DATABASE orbit OWNER orbit TEMPLATE template0;",
        "",
      ];

      const input = statements.join("\n");
      const ca = path.certificate("ca", "crt");

      const env = {
        PGPASSWORD: administrator,
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: ca,
        PGCONNECT_TIMEOUT: "5",
      };

      const settings = { input, env };

      await command.run(path.child(postgres, "psql"), args, settings);
    } finally {
      await adapter.stop(service);
    }
  }

  if (plan.roles.includes("db")) {
    await migration.run(manifest);

    await backup.prepare(manifest);

    await data.preserve(manifest);

    if (!store.entry(manifest, path.meta)) {
      await store.marker(manifest);
    }
  }

  await system.startup(manifest, preferences.startup);

  manifest.stage = "installed";
  manifest.installed = true;

  await ownership(manifest.entries);

  await store.write(manifest);
}

async function ownership(entries) {
  for (const entry of entries) {
    const details = await store.exists(entry.path);

    if (details) {
      entry.uid = details.uid;
      entry.gid = details.gid;
      entry.mode = details.mode & 0o777;
    }
  }
}

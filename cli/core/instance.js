import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import { internal } from "#cli/network/config.js";
import { error } from "#cli/core/error.js";
import { isIPv4 } from "node:net";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { parseEnv } from "node:util";
import * as primary from "#cli/core/primary.js";

export function validate(plan) {
  const number = plan.instance ?? 1;
  const integer = Number.isSafeInteger(number);
  const positive = number > 0;
  const valid = integer && positive;
  const address = plan.address ?? "127.0.0.1";

  if (!valid) {
    throw error("plan", { reason: "validation" });
  }

  if (typeof address !== "string") {
    throw error("plan", { reason: "validation" });
  }

  if (!isIPv4(address)) {
    throw error("plan", { reason: "validation" });
  }

  if (!internal(address)) {
    throw error("plan", { reason: "validation" });
  }

  for (const value of [plan.build, plan.database, plan.tls]) {
    if (value === undefined) {
      continue;
    }

    if (!path.absolute(value)) {
      throw error("plan", { reason: "absolute" });
    }
  }

  const ports = { db: 55432, was: 3443, caddy: 8443, ...plan.ports };
  const numbers = { db: number, was: number, caddy: number, ...plan.instances };
  const selected = (plan.roles ?? []).map((role) => ports[role]);
  const unique = new Set(selected).size === selected.length;

  if (!unique) {
    throw error("plan", { reason: "validation" });
  }

  for (const role of plan.roles ?? []) {
    const value = ports[role];
    const integer = Number.isInteger(value);
    const positive = value > 0;
    const bounded = value <= 65535;
    const valid = integer && positive && bounded;

    if (!valid) {
      throw error("plan", { reason: "validation" });
    }
  }

  for (const role of plan.roles ?? []) {
    const identity = numbers[role];
    const integer = Number.isSafeInteger(identity);
    const positive = identity > 0;
    const identified = integer && positive;

    if (!identified) {
      throw error("plan", { reason: "validation" });
    }
  }

  const result = { number, address, ports, numbers };

  return result;
}

async function tree(filename) {
  const details = await fs.lstat(filename);
  const root = details.uid === 0;
  const writable = Boolean(details.mode & 0o022);
  const readonly = !writable;
  const valid = root && readonly;

  if (!valid) {
    throw error("config");
  }

  if (details.isDirectory()) {
    for (const name of await fs.readdir(filename)) {
      await tree(path.child(filename, name));
    }

    return;
  }

  if (!details.isFile()) {
    throw error("config");
  }
}

async function read(filename, option = {}) {
  const parent = await fs.lstat(path.parent(filename));
  const directory = parent.isDirectory();
  const root = parent.uid === 0;
  const writable = Boolean(parent.mode & 0o022);
  const immutable = !writable;
  const safe = directory && root && immutable;

  if (!safe) {
    throw error("config");
  }

  const details = await fs.lstat(filename);
  const regular = details.isFile();
  const owned = details.uid === 0;
  const mutable = Boolean(details.mode & 0o022);
  const readonly = !mutable;
  const valid = regular && owned && readonly;

  if (!valid) {
    throw error("config");
  }

  if (option.secret) {
    if (details.mode & 0o077) {
      throw error("config");
    }
  }

  return await fs.readFile(filename, "utf8");
}

export async function prepare(plan, tools) {
  const settings = validate(plan);
  const result = { ...settings };

  if (plan.build !== undefined) {
    if (!plan.roles.includes("caddy")) {
      throw error("plan", { reason: "roles" });
    }

    await tree(plan.build);

    await read(path.child(plan.build, "index.html"));
  }

  let database = plan.database;

  const adding = plan.add === true;
  const backend = plan.roles.includes("was");
  const automatic = adding && backend;

  if (database === undefined) {
    if (automatic) {
      database = path.database;
    }
  }

  if (database !== undefined) {
    if (plan.roles.includes("db")) {
      throw error("plan", { reason: "roles" });
    }

    const contents = await read(database, { secret: true });
    const config = parseEnv(contents);

    if (automatic) {
      const state = await primary.state();
      const descriptor = state?.descriptor;

      if (!descriptor?.host) {
        throw error("config", { reason: "required" });
      }

      config.DB_HOST = descriptor.host;
      config.DB_PORT = String(descriptor.port);
      config.DB_ENABLED = "true";
    }

    const names = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];

    for (const name of names) {
      if (!config[name]) {
        throw error("config");
      }

      if (/[\r\n]/.test(config[name])) {
        throw error("config");
      }
    }

    if (!internal(config.DB_HOST)) {
      throw error("config");
    }

    const port = Number(config.DB_PORT);
    const integer = Number.isInteger(port);
    const positive = port > 0;
    const within = port <= 65535;
    const valid = integer && positive && within;

    if (!valid) {
      throw error("config");
    }

    if (config.DB_ENABLED !== "true") {
      throw error("config");
    }

    if (config.DB_SSL !== "true") {
      throw error("config");
    }

    const lines = ["DB_ENABLED=true", "DB_SSL=true"];

    for (const name of names) {
      lines.push(`${name}=${JSON.stringify(config[name])}`);
    }

    lines.push(`DB_CA=${JSON.stringify(path.certificate("ca", "crt"))}`, "");

    result.database = lines.join("\n");
  }

  if (plan.tls === undefined) {
    return result;
  }

  const ca = path.child(plan.tls, "ca.crt");
  const certificates = { "ca.crt": await read(ca) };

  for (const role of plan.roles) {
    const filename = path.child(plan.tls, `${role}.crt`);
    const certificate = await read(filename);

    const key = await read(path.child(plan.tls, `${role}.key`), {
      secret: true,
    });

    const leaf = new X509Certificate(certificate);
    const secret = createPrivateKey(key);

    const exported = createPublicKey(secret).export({
      type: "spki",
      format: "der",
    });

    const expected = leaf.publicKey.export({ type: "spki", format: "der" });

    if (!exported.equals(expected)) {
      throw error("config");
    }

    if (!leaf.checkIP(settings.address)) {
      throw error("config");
    }

    const args = ["verify", "-purpose", "sslserver", "-CAfile", ca, filename];

    await command.run(tools.openssl, args);

    certificates[`${role}.crt`] = certificate;
    certificates[`${role}.key`] = key;
  }

  result.certificates = certificates;

  return result;
}

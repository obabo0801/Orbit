import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as tools from "#cli/core/tools.js";
import { error } from "#cli/core/error.js";
import { randomUUID } from "node:crypto";
import * as instance from "#cli/core/instance.js";
import * as store from "#cli/core/manifest.js";
import * as primary from "#cli/core/primary.js";

export { usable } from "#cli/core/tools.js";

export function validate(plan) {
  let object = plan !== null;

  if (object) {
    object = typeof plan === "object";
  }

  let output = !object;

  if (!output) {
    output = plan.validation !== true;
  }

  if (output) {
    throw error("plan", { reason: "validation" });
  }

  const array = Array.isArray(plan.roles);

  let report = !array;

  if (!report) {
    report = !plan.roles.length;
  }

  if (report) {
    throw error("plan", { reason: "roles" });
  }

  const unique = new Set(plan.roles).size === plan.roles.length;

  const supported = plan.roles.every(function valid(role) {
    return ["db", "was", "caddy"].includes(role);
  });

  let received = !unique;

  if (!received) {
    received = !supported;
  }

  if (received) {
    throw error("plan", { reason: "roles" });
  }

  instance.validate(plan);

  for (const name of ["add", "startup"]) {
    const value = plan[name];

    if (value !== undefined) {
      if (typeof value !== "boolean") {
        throw error("plan", { reason: "validation" });
      }
    }
  }

  if (plan.add === true) {
    if (plan.roles.includes("db")) {
      throw error("plan", { reason: "roles" });
    }
  }

  return plan;
}

export async function read(filename) {
  if (!path.absolute(filename)) {
    throw error("plan", { reason: "absolute" });
  }

  let contents;

  try {
    contents = await fs.readFile(filename, "utf8");
  } catch (failure) {
    if (failure.code === "ENOENT") {
      throw error("plan", { reason: "missing" });
    }

    throw failure;
  }

  let plan;

  try {
    plan = JSON.parse(contents);
  } catch {
    throw error("plan", { reason: "document" });
  }

  return validate(plan);
}

async function source(plan) {
  const root = path.checkout;
  const packages = ["cli"];

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
    const folder = path.child(root, name);
    const file = path.child(folder, "package.json");

    try {
      await fs.access(file);
    } catch {
      throw error("plan", { reason: "source", target: folder });
    }
  }
}

function empty(value) {
  let absent = value === undefined;

  if (!absent) {
    absent = value === null;
  }

  let blank = typeof value === "string";

  if (blank) {
    blank = !value.trim();
  }

  const result = absent || blank;

  return result;
}

async function baseline(filename) {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw failure;
  }
}

export async function configure(filename, args) {
  if (!path.absolute(filename)) {
    throw error("plan", { reason: "absolute" });
  }

  const before = await baseline(filename);

  let plan = { validation: true, roles: ["db", "was", "caddy"] };

  if (before !== null) {
    plan = JSON.parse(before);
  }

  const fields = new Set([
    "roles",
    "instance",
    "address",
    "database",
    "build",
    "tls",
    "startup",
    "add",
    "was-port",
    "web-port",
    "db-port",
    "was-instance",
    "web-instance",
    "db-instance",
  ]);

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, "");
    const value = args[index + 1];
    const supported = fields.has(name);
    const supplied = value !== undefined;
    const valid = supported && supplied;

    if (!valid) {
      throw error("plan", { reason: "validation" });
    }

    if (name === "roles") {
      plan.roles = value.split(",").map((role) => {
        let selected;

        if (role === "web") {
          selected = "caddy";
        } else {
          selected = role;
        }

        return selected;
      });
    } else if (name.endsWith("-port")) {
      const role = name.slice(0, -5);

      let key;

      if (role === "web") {
        key = "caddy";
      } else {
        key = role;
      }

      plan.ports ??= {};
      plan.ports[key] = Number(value);
    } else if (name.endsWith("-instance")) {
      const role = name.slice(0, -9);

      let key;

      if (role === "web") {
        key = "caddy";
      } else {
        key = role;
      }

      plan.instances ??= {};
      plan.instances[key] = Number(value);
    } else if (name === "instance") {
      plan.instance = Number(value);
    } else if (["startup", "add"].includes(name)) {
      if (!["on", "off"].includes(value)) {
        throw error("plan", { reason: "validation" });
      }

      plan[name] = value === "on";
    } else {
      plan[name] = value;
    }
  }

  validate(plan);

  if (path.system()) {
    const record = await store.read();

    if (!record?.installed) {
      throw error("installation");
    }

    const text = JSON.stringify(plan, null, 2) + "\n";

    await primary.write(record, filename, text);
  } else {
    await save(filename, plan, before);
  }

  return plan;
}

async function save(filename, plan, before) {
  const text = JSON.stringify(plan, null, 2) + "\n";

  await fs.mkdir(path.parent(filename), { recursive: true, mode: 0o700 });

  if (before === null) {
    try {
      await fs.writeFile(filename, text, { flag: "wx", mode: 0o600 });
    } catch (failure) {
      if (failure.code === "EEXIST") {
        throw error("changed");
      }

      throw failure;
    }

    return;
  }

  const temporary = path.adjacent(filename, `plan.${randomUUID()}.tmp`);

  try {
    await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });

    if ((await baseline(filename)) !== before) {
      throw error("changed");
    }

    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(function absent(failure) {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function load(filename, option = {}) {
  const file = filename ?? path.plan();

  if (!path.absolute(file)) {
    throw error("plan", { reason: "absolute" });
  }

  const before = await baseline(file);

  let plan = { validation: true, roles: ["db", "was", "caddy"] };

  if (before !== null) {
    try {
      plan = JSON.parse(before);
    } catch {
      throw error("plan", { reason: "document" });
    }
  }

  let object = plan !== null;

  if (object) {
    object = typeof plan === "object";
  }

  if (object) {
    object = !Array.isArray(plan);
  }

  if (!object) {
    throw error("plan", { reason: "document" });
  }

  plan = { ...plan };

  const equal = before === null;

  let present;

  if (equal) {
    present = Boolean(filename);
  }

  let changed = equal && present;

  if (empty(plan.validation)) {
    plan.validation = true;
    changed = true;
  }

  let missing = empty(plan.roles);

  if (!missing) {
    const listed = Array.isArray(plan.roles);

    let enabled;

    if (listed) {
      enabled = !plan.roles.length;
    }

    missing = listed && enabled;
  }

  if (missing) {
    if (!option.ask) {
      throw error("plan", { reason: "roles" });
    }

    plan.roles = await option.ask({ kind: "roles" });

    if (!plan.roles) {
      throw error("cancelled");
    }

    changed = true;
  }

  validate(plan);

  const names = ["node", "pnpm"];

  if (plan.roles.includes("db")) {
    names.push("postgres");
  }

  if (plan.roles.includes("caddy")) {
    names.push("caddy");
  }

  for (const name of names) {
    const supplied = plan[name];
    const prepared = option.prepared;
    const setting = { supplied, prepared };

    plan[name] = await tools.resolve(name, setting);
  }

  await source(plan);

  if (changed) {
    if (before !== null) {
      if (!option.ask) {
        throw error("config", { reason: "required" });
      }

      const approved = await option.ask({ kind: "save" });

      if (!approved) {
        throw error("cancelled");
      }
    }

    const persistent = { ...plan };

    for (const item of option.prepared ?? []) {
      delete persistent[item.name];
    }

    await save(file, persistent, before);
  }

  return plan;
}

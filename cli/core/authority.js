import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as primary from "#cli/core/primary.js";
import * as command from "#cli/core/process.js";
import { lock } from "#cli/core/lock.js";

async function machine() {
  const contents = await fs.readFile(path.machine, "utf8");
  const result = createHash("sha256").update(contents.trim()).digest("hex");

  return result;
}

export async function read() {
  command.root();

  const record = await store.read();
  const entry = store.entry(record, path.authority);
  const details = await fs.lstat(path.authority);
  const secure = store.secure(details);
  const registered = Boolean(entry?.hash);

  if (!secure) {
    throw new Error("FAILOVER_AUTHORITY: Invalid promotion authority.");
  }

  if (!registered) {
    throw new Error("FAILOVER_AUTHORITY: Invalid promotion authority.");
  }

  const hash = await store.digest(path.authority);

  if (hash !== entry.hash) {
    throw new Error("FAILOVER_AUTHORITY: Invalid promotion authority.");
  }

  const value = JSON.parse(await fs.readFile(path.authority, "utf8"));
  const identity = await machine();

  if (value.controller !== identity) {
    throw new Error("FAILOVER_CONTROLLER: Controller identity does not match.");
  }

  return value;
}

export async function approve(record, option) {
  command.root();

  if (option.confirmed !== true) {
    throw new Error("FAILOVER_CONFIRM: Explicit approval is required.");
  }

  const controller = await machine();

  const value = {
    ...option,
    controller,
    version: 1,
    boundary: "single",
    witness: false,
  };

  delete value.confirmed;

  const text = JSON.stringify(value) + "\n";

  await primary.write(record, path.authority, text);

  return value;
}

export async function claim() {
  const approval = await read();
  const enabled = approval.enabled === true;
  const single = approval.boundary === "single";
  const valid = enabled && single;

  if (!valid) {
    throw new Error("FAILOVER_AUTHORITY: Invalid promotion authority.");
  }

  const release = await lock("failover");
  const result = { approval, release };

  return result;
}

export async function adapter(approval) {
  const filename = approval.adapter;

  if (typeof filename !== "string") {
    throw new Error("FAILOVER_ADAPTER: Invalid operating adapter.");
  }

  const details = await fs.lstat(filename);

  if (!store.secure(details)) {
    throw new Error("FAILOVER_ADAPTER: Invalid operating adapter.");
  }

  const hash = await store.digest(filename);

  if (hash !== approval.hash) {
    throw new Error("FAILOVER_ADAPTER: Invalid operating adapter.");
  }

  return filename;
}

import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as command from "#cli/core/process.js";

export async function write(record, filename, contents, option = {}) {
  command.root();

  await store.safe(filename);

  const details = await store.exists(filename);
  const registered = store.entry(record, filename);
  const mode = option.mode ?? 0o600;

  if (!details) {
    if (registered) {
      await fs.writeFile(filename, contents, { flag: "wx", mode });

      registered.hash = await store.digest(filename);
      registered.done = true;

      await store.write(record);

      return;
    }

    await store.file(record, filename, contents, { mode });

    return;
  }

  const entry = store.entry(record, filename);
  const file = details.isFile();
  const owned = Boolean(entry?.hash);
  const valid = file && owned;

  if (!valid) {
    throw new Error("PROMOTION_OWNER: Unmanaged operating file.");
  }

  if ((await store.digest(filename)) !== entry.hash) {
    throw new Error(
      "PROMOTION_CHANGED: Registered operating file has changed.",
    );
  }

  const temporary = path.adjacent(filename, ".promotion-" + randomUUID());

  try {
    await fs.writeFile(temporary, contents, { flag: "wx", mode });

    await fs.chown(temporary, details.uid, details.gid);

    await fs.rename(temporary, filename);

    entry.hash = await store.digest(filename);
    entry.mode = mode;

    await store.write(record);
  } finally {
    await fs.unlink(temporary).catch((failure) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function remove(record, filename) {
  command.root();

  const entry = store.entry(record, filename);
  const details = await store.exists(filename);

  if (details) {
    const registered = Boolean(entry?.hash);

    let matching = false;

    if (registered) {
      const hash = await store.digest(filename);

      matching = hash === entry.hash;
    }

    const valid = registered && matching;

    if (!valid) {
      throw new Error(
        "PROMOTION_CHANGED: Registered operating file has changed.",
      );
    }

    await fs.unlink(filename);
  }

  record.entries = record.entries.filter((value) => {
    return value !== entry;
  });

  await store.write(record);
}

export async function state() {
  const details = await store.exists(path.transition);

  if (!details) {
    return null;
  }

  if (!store.secure(details)) {
    throw new Error("PROMOTION_OWNER: Unmanaged operating file.");
  }

  const text = await fs.readFile(path.transition, "utf8");

  return JSON.parse(text);
}

export async function guard(role, option = {}) {
  const value = await state();
  const blocked = Boolean(await store.exists(path.blocked));
  const database = role === "DB";

  if (database && blocked) {
    const matching = option.id === value?.id;
    const joining = value?.stage === "joining";
    const privileged = process.getuid?.() === 0;

    const standby = Boolean(
      await store.exists(path.child(path.db, "standby.signal")),
    );

    const permitted = matching && joining && privileged && standby;

    if (!permitted) {
      throw new Error("PROMOTION_FENCED: Database is fenced.");
    }
  }

  if (!value) {
    return;
  }

  const active = !["applied", "joined", "aborted", "complete"].includes(
    value.stage,
  );

  const affected = ["WAS", "DB", "migration", "backup"].includes(role);
  const unavailable = ["applied", "joining", "joined"].includes(value.stage);
  const operation = ["migration", "backup"].includes(role);
  const standby = unavailable && operation;

  if (standby) {
    const record = await store.read();

    const replica = record.services.some((entry) => {
      const database = entry.role === "DB";
      const recovering = entry.mode === "replica";
      const result = database && recovering;

      return result;
    });

    if (replica) {
      throw new Error("PROMOTION_REPLICA: Read-only replica is required.");
    }
  }

  const prevented = active && affected;

  if (prevented) {
    const matching = option.id === value.id;
    const privileged = process.getuid?.() === 0;
    const permitted = matching && privileged;

    if (!permitted) {
      throw new Error("PROMOTION_HELD: Transition is already in progress.");
    }
  }
}

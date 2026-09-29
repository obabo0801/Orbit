import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import * as path from "#cli/core/path.js";
import * as monitor from "#cli/core/monitor.js";
import { error } from "#cli/core/error.js";

export const limit = 64 * 1024 * 1024;

const pattern = /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/u;
const compress = promisify(zlib.gzip);
const expand = promisify(zlib.gunzip);

const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function date(time) {
  const parts = calendar.formatToParts(time);

  const part = (type) =>
    parts.find((part) => {
      return part.type === type;
    }).value;

  const result = [part("year"), part("month"), part("day")].join("-");

  return result;
}

async function regular(filename) {
  const details = await fs.lstat(filename);

  let answer = !details.isFile();

  if (!answer) {
    answer = details.isSymbolicLink();
  }

  if (!answer) {
    answer = details.size > limit * 2;
  }

  if (answer) {
    throw error("monitoring");
  }
}

export async function content(filename) {
  await regular(filename);

  const buffer = await fs.readFile(filename);
  const setting = { maxOutputLength: limit * 2 };

  let contents;

  if (filename.endsWith(".gz")) {
    contents = await expand(buffer, setting);
  } else {
    contents = buffer;
  }

  return contents.toString("utf8");
}

function decode(content) {
  const records = [];

  for (const line of content.split("\n")) {
    try {
      const batch = JSON.parse(line);

      let valid = Number.isFinite(batch?.time);

      if (valid) {
        valid = Array.isArray(batch.samples);
      }

      if (valid) {
        records.push(batch);
      }
    } catch {
      continue;
    }
  }

  return records;
}

export async function read(option = {}) {
  const directory = option.directory ?? path.history;
  const now = option.time ?? Date.now();
  const from = Math.max(option.from ?? 0, now - monitor.policy.retention);
  const to = option.to ?? now;
  const listing = await fs.readdir(directory).catch(() => []);
  const names = listing.filter((name) => pattern.test(name)).sort();
  const records = new Map();

  for (const name of names) {
    const day = name.slice(0, 10);

    let valid = day < date(from);

    if (!valid) {
      valid = day > date(to);
    }

    if (valid) {
      continue;
    }

    const filename = path.child(directory, name);

    try {
      for (const batch of decode(await content(filename))) {
        let outcome = batch.time < from;

        if (!outcome) {
          outcome = batch.time > to;
        }

        if (outcome) {
          continue;
        }

        const key = `${batch.source}:${batch.time}`;

        records.set(key, batch);
      }
    } catch {
      continue;
    }
  }

  const prepared = [...records.values()].sort((first, second) => {
    const result = first.time - second.time;

    return result;
  });

  return prepared;
}

export async function append(batch, option = {}) {
  const directory = option.directory ?? path.history;
  const filename = path.child(directory, `${date(batch.time)}.jsonl`);
  const write = fs.constants.O_WRONLY;
  const append = fs.constants.O_APPEND;
  const create = fs.constants.O_CREAT;
  const follow = fs.constants.O_NOFOLLOW;
  const flags = write | append | create | follow;
  const file = await fs.open(filename, flags, 0o600);

  try {
    const line = JSON.stringify(batch) + "\n";

    await file.writeFile(line);

    await file.sync();
  } finally {
    await file.close();
  }
}

async function replace(filename, content) {
  const temporary = filename + ".tmp";
  const write = fs.constants.O_WRONLY;
  const create = fs.constants.O_CREAT;
  const truncate = fs.constants.O_TRUNC;
  const follow = fs.constants.O_NOFOLLOW;
  const flags = write | create | truncate | follow;
  const file = await fs.open(temporary, flags, 0o600);

  try {
    try {
      await file.writeFile(content);

      await file.sync();
    } finally {
      await file.close();
    }

    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch((failure) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function prune(time, option = {}) {
  const directory = option.directory ?? path.history;
  const from = time - monitor.policy.retention;

  const names = (await fs.readdir(directory))
    .filter((name) => pattern.test(name))
    .sort();

  const days = new Map();

  for (const name of names) {
    const filename = path.child(directory, name);

    let text;

    try {
      text = await content(filename);
    } catch {
      continue;
    }

    const day = name.slice(0, 10);

    let entry = days.get(day);

    if (!entry) {
      entry = { day, files: [], records: new Map() };

      days.set(day, entry);
    }

    entry.files.push(filename);

    for (const batch of decode(text)) {
      if (batch.time < from) {
        continue;
      }

      const key = `${batch.source}:${batch.time}`;

      entry.records.set(key, batch);
    }
  }

  const retained = [...days.values()].map((entry) => {
    const records = [...entry.records.values()].sort((first, second) => {
      const result = first.time - second.time;

      return result;
    });

    const lines = records.map((batch) => JSON.stringify(batch));
    const output = { ...entry, lines };

    return output;
  });

  let size = retained.reduce((total, file) => {
    const text = total + Buffer.byteLength(file.lines.join("\n") + "\n");

    return text;
  }, 0);

  for (const file of retained) {
    while (true) {
      let valid = size > limit;

      if (valid) {
        valid = file.lines.length;
      }

      if (!valid) {
        break;
      }

      size -= Buffer.byteLength(file.lines.shift() + "\n");
    }

    if (!file.lines.length) {
      for (const filename of file.files) {
        await fs.unlink(filename);
      }

      continue;
    }

    const text = file.lines.join("\n") + "\n";
    const archived = file.day < date(time);

    let extension;

    if (archived) {
      extension = ".jsonl.gz";
    } else {
      extension = ".jsonl";
    }

    const filename = path.child(directory, file.day + extension);

    let contents;

    if (filename.endsWith(".gz")) {
      contents = await compress(text);
    } else {
      contents = text;
    }

    await replace(filename, contents);

    for (const previous of file.files) {
      if (previous !== filename) {
        await fs.unlink(previous);
      }
    }
  }
}

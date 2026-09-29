import * as command from "#cli/core/process.js";
import * as system from "#cli/core/system.js";
import { error } from "#cli/core/error.js";

export async function entries(service, option = {}) {
  const unit = system.unit(service);
  const limit = option.limit ?? 100;

  const args = [
    "--no-pager",
    "--output=json",
    `--lines=${limit}`,
    "--unit",
    unit,
  ];

  if (option.cursor) {
    args.splice(2, 1);

    args.push(`--cursor=${option.cursor}`);
  }

  const output = await command.run("/usr/bin/journalctl", args, option);

  const entries = output.output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(function entry(line) {
      const value = JSON.parse(line);
      const id = value.__CURSOR;
      const time = Number(value.__REALTIME_TIMESTAMP) / 1000;

      let text;

      if (typeof value.MESSAGE === "string") {
        text = value.MESSAGE;
      } else {
        text = "";
      }

      const priority = Number(value.PRIORITY);
      const result = { id, time, text, priority };

      return result;
    });

  let valid = option.cursor;

  if (valid) {
    valid = entries[0]?.id !== option.cursor;
  }

  if (valid) {
    throw error("expired");
  }

  return entries;
}

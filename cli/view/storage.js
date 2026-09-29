import * as host from "#cli/core/host.js";
import * as storage from "#cli/core/storage.js";
import * as drawing from "#cli/view/table.js";
import * as screen from "#cli/view/screen.js";
import * as input from "#cli/view/input.js";
import { amount } from "#cli/view/metrics.js";
import { locale } from "#cli/core/locale.js";
import { error } from "#cli/core/error.js";
import * as path from "#cli/core/path.js";

export function layout(items, translate, option = {}) {
  const title = option.title ?? "placement";
  const frame = drawing.frame(translate(title));

  const selected = items.findIndex((_, index) => {
    const valid = String(index + 1) === option.selected;

    return valid;
  });

  const rows = items.map((item, index) => [`${index + 1}. ${item}`]);
  const positions = [];
  const setting = { rounded: true, selected, positions };
  const lines = drawing.table(null, rows, setting).split("\n");

  lines[0] = drawing.border(frame.top);

  const targets = positions.map(function target(row, index) {
    const id = String(index + 1);
    const result = { id, row };

    return result;
  });

  if (option.details) {
    const heading = drawing.table(null, option.details, { rounded: true });
    const prefix = heading.split("\n");

    prefix[0] = drawing.border(frame.top);
    lines[0] = drawing.border(drawing.frame("").top);

    for (const target of targets) {
      target.row += prefix.length;
    }

    lines.unshift(...prefix);
  }

  const back = screen.actions([], translate, { selected: option.selected });

  for (const target of back.targets) {
    target.row += lines.length;
  }

  targets.push(...back.targets);

  lines.push(...back.lines);

  const result = { lines, targets };

  return result;
}

async function choose(drives, translate, option = {}) {
  if (!drives.length) {
    throw error("preparation", { reason: "volume" });
  }

  let valid = drives.length === 1;

  if (valid) {
    valid = option.skip !== false;
  }

  if (valid) {
    return drives[0].name;
  }

  const items = drives.map((drive) => {
    const text = `${drive.name}  ${amount(drive.free)}`;

    return text;
  });

  const draw = (selected) => layout(items, translate, { selected });
  const selection = await screen.page(draw);

  let result;

  if (selection === "0") {
    result = null;
  } else {
    result = drives[Number(selection) - 1].name;
  }

  return result;
}

async function existing(entry, drives, translate) {
  if (entry.version !== 2) {
    throw error("preparation", { reason: "wslversion" });
  }

  const drive = path.drive(entry.base);

  const volume = drives.find((item) => {
    return item.name === drive;
  });

  if (!volume) {
    throw error("preparation", { reason: "volume" });
  }

  const details = [
    [translate("placement"), drive],
    [translate("space"), amount(volume.free)],
  ];

  const items = [translate("keep"), translate("relocate")];

  const draw = (selected) =>
    layout(items, translate, { title: "ubuntu", details, selected });

  const destinations = drives.filter(host.usable).filter((item) => {
    return item.name !== drive;
  });

  while (true) {
    const selection = await screen.page(draw);

    if (selection === "0") {
      return null;
    }

    if (selection === "1") {
      const result = { name: entry.name };

      return result;
    }

    const destination = await choose(destinations, translate, { skip: false });

    if (destination) {
      const output = { entry, drive: destination };

      return output;
    }
  }
}

export async function select(language) {
  const owned = !input.active();

  if (owned) {
    input.open();
  }

  try {
    const translate = await locale({ language });
    const report = await host.read();
    const entries = storage.candidates(report.entries);

    if (entries.length > 1) {
      throw error("distribution");
    }

    if (entries.length) {
      return await existing(entries[0], report.drives, translate);
    }

    const other = storage.candidates(report.entries, "");

    if (other.length) {
      throw error("distribution");
    }

    const drives = report.drives.filter(host.usable);
    const drive = await choose(drives, translate);

    let result;

    if (drive) {
      result = { drive };
    } else {
      result = null;
    }

    return result;
  } finally {
    if (owned) {
      input.close();
    }
  }
}

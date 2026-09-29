import * as path from "#cli/core/path.js";

export const thresholds = { cpu: [70, 90], memory: [70, 90], disk: [80, 90] };

export const scopes = { DB: path.db, WEB: path.build, WAS: path.folder("was") };

export function tone(name, value) {
  if (!Number.isFinite(value)) {
    return "dim";
  }

  const [warning, error] = thresholds[name];

  if (value >= error) {
    return "error";
  }

  let result;

  if (value >= warning) {
    result = "warning";
  } else {
    result = "success";
  }

  return result;
}

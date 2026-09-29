import * as color from "#cli/view/color.js";
import * as monitor from "#cli/core/monitor.js";
import * as health from "#cli/core/health.js";
import * as resource from "#cli/core/resource.js";
import * as time from "#cli/view/time.js";

export const symbols = [
  { icon: "i", tone: "info" },
  { icon: "✓", tone: "success" },
  { icon: "!", tone: "warning" },
  { icon: "×", tone: "error" },
];

export function items(report, selected = "") {
  const checks = monitor.events(report).map((event) => event.level);

  const result = symbols.map(function item(symbol) {
    const count = checks.filter((check) => {
      return check === symbol.tone;
    }).length;

    const id = symbol.tone;

    let marker;

    if (id === selected) {
      marker = "› ";
    } else {
      marker = "  ";
    }

    const text = `${marker}${symbol.icon} ${count}`;
    const result = { id, count, text };

    return result;
  });

  return result;
}

export function summary(report, selected = "") {
  const result = items(report, selected)
    .map((item) => item.text)
    .join("    ");

  return result;
}

export function format(text, selected = "") {
  let result = text;

  for (const symbol of symbols) {
    const pattern = new RegExp(`(?:› |  )${symbol.icon} \\d+`, "u");

    function format(value) {
      let result;

      if (selected === symbol.tone) {
        result = color.highlight(value);
      } else {
        result = color.paint(value, symbol.tone);
      }

      return result;
    }

    result = result.replace(pattern, format);
  }

  return result;
}

export function duration(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours) {
    const text = `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;

    return text;
  }

  if (minutes) {
    const result = `${minutes}m ${seconds % 60}s`;

    return result;
  }

  const text = `${seconds}s`;

  return text;
}

function decimal(value) {
  const result = String(Number(value.toFixed(1)));

  return result;
}

export function amount(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];

  let exponent;

  if (value > 0) {
    exponent = Math.floor(Math.log10(value) / 3);
  } else {
    exponent = 0;
  }

  const index = Math.max(0, Math.min(units.length - 1, exponent));
  const quantity = decimal(value / 1000 ** index);
  const text = `${quantity} ${units[index]}`;

  return text;
}

function usage(name, metrics, translate) {
  if (name === "cpu") {
    let result;

    if (Number.isFinite(metrics.processors)) {
      result = `${decimal(metrics.processors)} Core`;
    } else {
      result = "";
    }

    return result;
  }

  let memory = Number.isFinite(metrics.resident);

  if (memory) {
    memory = Number.isFinite(metrics.ram);
  }

  let response = name === "memory";

  if (response) {
    response = memory;
  }

  if (response) {
    const text = `${amount(metrics.resident)} (${translate("total")}: ${amount(metrics.ram)})`;

    return text;
  }

  let storage = Number.isFinite(metrics.used);

  if (storage) {
    storage = Number.isFinite(metrics.total);
  }

  if (storage) {
    storage = Number.isFinite(metrics.free);
  }

  let resolved = name === "disk";

  if (resolved) {
    resolved = storage;
  }

  if (resolved) {
    const value = `${amount(metrics.used)} (${translate("total")}: ${amount(metrics.total)})`;

    return value;
  }

  return "";
}

export function active(report) {
  if (report.state === "unknown") {
    return false;
  }

  if (health.up(report)) {
    return true;
  }

  const known = Boolean(report.system);
  const stopped = report.system !== "active";
  const inactive = known && stopped;

  if (inactive) {
    return false;
  }

  if (report.role === "WAS") {
    return report.live === true;
  }

  let result = report.role === "DB";

  if (result) {
    result = report.system === "active";
  }

  if (result) {
    result = report.replication?.recovery === true;
  }

  if (result) {
    result = report.replication.readonly === "on";
  }

  return result;
}

export function panels(report, entry, translate) {
  const unavailable = report.state === "unavailable";
  const running = active(report);
  const inactive = !running;
  const failed = unavailable && inactive;

  if (failed) {
    return down(report, entry, translate);
  }

  const stopped = entry.down ?? report.stopped;

  let uptime;

  if (Number.isFinite(report.uptime)) {
    uptime = duration(report.uptime);
  } else {
    uptime = null;
  }

  let latency;

  if (Number.isFinite(report.latency)) {
    latency = `${report.latency.toFixed(1)} ms`;
  } else {
    latency = null;
  }

  let downtime;

  if (stopped) {
    downtime = time.format(stopped);
  } else {
    downtime = null;
  }

  let commit;

  if (report.commit) {
    commit = revision(report.commit);
  } else {
    commit = null;
  }

  const values = { commit, uptime, latency, downtime };
  const metrics = report.resource ?? {};

  const names = Object.keys(values).filter((name) => {
    return values[name] !== null;
  });

  const resources = ["cpu", "memory", "disk"].filter((name) => {
    let result = Number.isFinite(metrics[name]);

    if (result) {
      result = usage(name, metrics, translate);
    }

    return result;
  });

  let filesystem = resources.includes("disk");

  if (filesystem) {
    filesystem = metrics.scope;
  }

  const rows = names.map(function row(name) {
    const label = translate(name);
    const text = values[name];
    const result = { label, text, format: String };

    return result;
  });

  for (const name of resources) {
    const value = metrics[name];
    const percentage = `${decimal(value)}%`;
    const detail = usage(name, metrics, translate);
    const suffix = ` [${percentage}]`;
    const label = translate(name);
    const text = `${detail}${suffix}`;
    const state = resource.tone(name, value);

    let tone;

    if (state === "success") {
      tone = "accent";
    } else {
      tone = state;
    }

    function format(text) {
      const result = text.replace(percentage, (value) =>
        color.paint(value, tone),
      );

      return result;
    }

    rows.push({ label, text, format });

    let response = name === "disk";

    if (response) {
      response = filesystem;
    }

    if (response) {
      const label = translate("filesystem");
      const text = metrics.scope;

      function format(value) {
        return color.paint(value, "empty");
      }

      rows.push({ label, text, format });
    }
  }

  const offline = report.state === "unknown";
  const missing = report.resource == null;
  const known = Boolean(report.last);
  const retained = missing && known;
  const preserved = offline || retained;

  if (preserved) {
    if (offline) {
      rows.push({ label: translate("state"), text: "", format: String });
    }

    const last = report.last;

    if (last) {
      const primary = last.replication?.recovery === false;

      let replication;

      if (primary) {
        replication = translate("primary");
      } else {
        replication = undefined;
      }

      let pid;

      if (last.pid) {
        pid = last.pid;
      } else {
        pid = undefined;
      }

      let commit;

      if (last.commit) {
        commit = revision(last.commit);
      } else {
        commit = undefined;
      }

      const values = {
        pid: pid,
        commit: commit,
        role: last.mode ?? last.role,
        timeline: last.replication?.timeline,
        replication: last.replication?.receiver?.status ?? replication,
      };

      for (const [name, text] of Object.entries(values)) {
        if (text === undefined) {
          continue;
        }

        let value;

        if (name === "role") {
          value = translate(text);
        } else {
          value = text;
        }

        rows.push({
          label: `${translate("preserved")} ${translate(name)}`,
          text: String(value),
          format: String,
        });
      }

      const resources = panels({ resource: last.resource }, {}, translate);

      for (const row of resources) {
        rows.push({ ...row, label: `${translate("preserved")} ${row.label}` });
      }

      if (report.seen) {
        rows.push({
          label: `${translate("preserved")} ${translate("time")}`,
          text: time.format(report.seen),
          format: String,
        });
      }
    }
  }

  return rows;
}

function down(report, entry, translate) {
  const sample = entry.timeline?.findLast((sample) => sample.up);
  const last = report.last ?? sample ?? {};
  const commit = report.commit ?? last.commit ?? sample?.commit;

  const uptime = [report.uptime, last.uptime, sample?.uptime].find(
    Number.isFinite,
  );

  const stopped = entry.down ?? report.stopped;

  let version;

  if (commit) {
    version = revision(commit);
  } else {
    version = null;
  }

  let runtime;

  if (Number.isFinite(uptime)) {
    runtime = duration(uptime);
  } else {
    runtime = null;
  }

  let downtime;

  if (stopped) {
    downtime = time.format(stopped);
  } else {
    downtime = null;
  }

  const values = { commit: version, uptime: runtime, downtime };

  const names = Object.keys(values).filter((name) => {
    return values[name] != null;
  });

  const rows = names.map(function row(name) {
    const label = translate(name);
    const text = values[name];
    const result = { label, text, format: String };

    return result;
  });

  const metrics = report.resource ?? last.resource ?? sample?.resource ?? {};

  for (const name of ["cpu", "memory", "disk"]) {
    const value = metrics[name];
    const detail = usage(name, metrics, translate);

    let text;

    if (Number.isFinite(value)) {
      const percentage = `${decimal(value)}%`;

      if (detail) {
        text = `${detail} [${percentage}]`;
      } else {
        text = percentage;
      }
    } else if (name === "memory") {
      const resident = metrics.resident ?? metrics.rss;

      if (Number.isFinite(resident)) {
        text = amount(resident);
      } else {
        text = null;
      }
    } else if (name === "disk") {
      if (Number.isFinite(metrics.used)) {
        text = amount(metrics.used);
      } else {
        text = null;
      }
    }

    if (text) {
      const label = translate(name);

      rows.push({ label, text, format: String });
    }
  }

  if (metrics.scope) {
    const label = translate("filesystem");
    const text = metrics.scope;

    rows.push({ label, text, format: String });
  }

  return rows;
}

export function revision(value) {
  if (typeof value === "string") {
    if (/^[a-f\d]{40}$/iu.test(value)) {
      return value.slice(0, 12);
    }
  }

  return value;
}

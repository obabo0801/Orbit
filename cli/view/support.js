import * as metrics from "#cli/view/metrics.js";
import * as service from "#cli/view/service.js";
import * as logs from "#cli/view/logs.js";
import * as color from "#cli/view/color.js";
import * as drawing from "#cli/view/table.js";
import * as time from "#cli/view/time.js";

export function panels(report, entry, translate) {
  const fields = [];

  function add(name, value, key) {
    let response = value === undefined;

    if (!response) {
      response = value === null;
    }

    if (!response) {
      response = value === "";
    }

    if (response) {
      return;
    }

    let text;

    if (key) {
      text = translate(value);
    } else {
      text = String(value);
    }

    let state;

    if (key) {
      state = value;
    } else {
      state = undefined;
    }

    fields.push({ name, text, key: state });
  }

  let state;

  if (report.name === "Tailscale") {
    state = report.daemon;

    const missing = state === null;
    const absent = state === undefined;
    const empty = missing || absent;

    if (empty) {
      if (report.state === "unknown") {
        state = "unknown";
      } else {
        state = undefined;
      }
    }
  } else {
    state = report.system ?? report.state;
  }

  const fallback = "unlinked";
  const status = state || fallback;

  add("state", status, true);

  if (Number.isFinite(report.uptime)) {
    const uptime = metrics.duration(report.uptime);

    add("uptime", uptime);
  }

  let address;

  if (report.name === "Vercel") {
    address = report.address;
  } else {
    address = report.public;
  }

  if (report.name === "Tailscale") {
    const funnels = { ...report.origins, ...report.funnels };

    for (const name of Object.keys(funnels)) {
      const funnel = report.funnels?.[name];
      const address = report.origins?.[name] ?? funnel?.address;

      if (address) {
        const ready = funnel?.state === "ready";
        const colored = color.supported();
        const ordinary = ready || colored;

        let text;

        if (ordinary) {
          text = address;
        } else {
          text = `${address} ×`;
        }

        let tone;

        if (ready) {
          tone = undefined;
        } else {
          tone = "empty";
        }

        fields.push({ name: "funnel", text, tone });
      }
    }
  } else {
    add("public", address);
  }

  if (report.name === "Tailscale") {
    for (const address of String(report.address ?? "").split(", ")) {
      add("address", address);
    }

    add("hostname", report.hostname);
  }

  if (Number.isFinite(report.latency)) {
    add("latency", `${report.latency.toFixed(1)} ms`);
  }

  if (report.pid) {
    add("pid", report.pid);
  }

  if (report.checked) {
    add("checked", time.format(report.checked));
  }

  const width = Math.max(
    0,
    ...fields.map((field) => drawing.width(translate(field.name))),
  );

  const result = fields.map(function row(field) {
    const label = translate(field.name);
    const padding = " ".repeat(width - drawing.width(label));
    const prefix = `${label}${padding} : `;
    const text = prefix + field.text;

    function format(value) {
      const detail = value.slice(prefix.length);

      if (field.tone) {
        return value.replace(detail, (value) => color.paint(value, field.tone));
      }

      let valid = !field.key;

      if (!valid) {
        valid = !detail;
      }

      if (valid) {
        return value;
      }

      const output = value.replace(detail, (value) =>
        color.state(value, field.key),
      );

      return output;
    }

    const result = { text, format };

    return result;
  });

  return result;
}

export async function open(manifest, name, translate) {
  function order(values) {
    return values.filter((report) => service.supporting.includes(report.name));
  }

  function items(report) {
    let result;

    if (report.unit) {
      result = ["logs"];
    } else {
      result = [];
    }

    return result;
  }

  async function action(name, report) {
    if (name !== "logs") {
      return;
    }

    const services = [report];
    const selection = { ...manifest, services };

    await logs.open(selection, translate, { title: report.name });
  }

  const option = { order, panels, items, action, history: false };

  await service.detail(manifest, name, translate, option);
}

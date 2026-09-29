import * as metrics from "#cli/view/metrics.js";
import * as monitor from "#cli/core/monitor.js";
import * as drawing from "#cli/view/table.js";
import * as color from "#cli/view/color.js";
import * as screen from "#cli/view/screen.js";
import * as input from "#cli/view/input.js";
import * as logs from "#cli/view/logs.js";
import * as events from "#cli/view/events.js";
import * as path from "#cli/core/path.js";
import * as progress from "#cli/view/progress.js";
import * as cluster from "#cli/core/cluster.js";

function state(report) {
  let result;

  if (metrics.active(report)) {
    result = "UP";
  } else if (report.state === "unknown") {
    result = "";
  } else {
    result = "DOWN";
  }

  return result;
}

export function summary(reports, translate, option = {}) {
  const instances = monitor.order(reports);

  const rows = instances.map(function row(report) {
    const status = state(report);

    let name;

    if (option.selected === report.name) {
      name = `› ${report.name}`;
    } else {
      name = report.name;
    }

    let role = report.role;

    if (role === "DB") {
      if (report.mode) {
        role = translate(report.mode);
      } else if (report.state === "unknown") {
        role = status;
      } else {
        role = "DOWN";
      }
    }

    let address = report.address;

    const host = Boolean(report.host);
    const http = report.role !== "DB";
    const managed = host && http;
    const present = Boolean(address);
    const visible = managed && present;

    if (visible) {
      address = new URL(address).host;
    }

    const result = [name, status, role, address, report.pid];

    return result;
  });

  const states = instances.map((report) => state(report).toLowerCase());
  const headers = ["service", "state", "role", "address", "pid"].map(translate);
  const positions = [];

  const selected = instances.findIndex((report) => {
    return report.name === option.selected;
  });

  const setting = { states, positions, selected, rounded: true };
  const lines = drawing.table(headers, rows, setting).split("\n");

  const targets = instances.map(function item(report, index) {
    const id = report.name;
    const row = positions[index];
    const result = { id, row };

    return result;
  });

  const result = { lines, targets };

  return result;
}

function columns(headers, reports, length) {
  const names = reports.map((report) => {
    const text = drawing.width(report.name) + 2;

    return text;
  });

  const service = Math.max(drawing.width(headers[0]), ...names) + 2;
  const status = Math.max(drawing.width(headers[1]), 4) + 2;
  const history = length - service - status - 4;

  let result;

  if (history >= 4) {
    result = [service, status, history];
  } else {
    result = [length - 2];
  }

  return result;
}

export function layout(record, translate, option = {}) {
  const { name, selected = "" } = option;
  const { report, entry, reports } = record.read(name);
  const frame = drawing.frame(name);
  const labels = metrics.items(report, selected);
  const summary = metrics.summary(report, selected);
  const heading = drawing.center(summary, frame.content);
  const inline = drawing.width(summary) <= frame.content;
  const targets = [];
  const points = [];

  let column = 2 + Math.floor((frame.content - drawing.width(summary)) / 2);

  function format(text) {
    return metrics.format(text, selected);
  }

  let panels;

  if (option.panels) {
    panels = option.panels(report, entry, translate);
  } else {
    panels = metrics.panels(report, entry, translate);
  }

  const lines = [drawing.border(frame.top)];

  if (inline) {
    lines.push(frame.row(heading, format));

    for (const item of labels) {
      const id = item.id;
      const row = 1;
      const from = column + 1;
      const to = from + drawing.width(item.text);

      targets.push({ id, row, from, to });

      column += drawing.width(item.text) + 4;
    }
  } else {
    for (const item of labels) {
      const id = item.id;
      const row = lines.length;

      targets.push({ id, row });

      lines.push(frame.row(item.text, format));
    }
  }

  lines.push(drawing.border(frame.bottom), "");

  const checked = panels.some((panel) => panel.label);

  let accepted;

  if (checked) {
    accepted = frame.length >= 9;
  }

  const labelled = checked && accepted;

  const width = Math.max(
    0,
    ...panels.map((panel) => drawing.width(panel.label)),
  );

  const length = Math.min(width + 2, Math.floor((frame.length - 3) / 2));

  let lengths;

  if (labelled) {
    lengths = [length, frame.length - length - 3];
  } else {
    lengths = [frame.length - 2];
  }

  const rows = panels.map(function row(panel) {
    let text;

    if (panel.label) {
      text = `${panel.label} ${panel.text}`;
    } else {
      text = panel.text;
    }

    let values;

    if (labelled) {
      values = [panel.label, panel.text];
    } else {
      values = [text];
    }

    let formats;

    if (labelled) {
      formats = [String, panel.format];
    } else {
      formats = [panel.format];
    }

    const result = { values, formats, align: "left" };

    return result;
  });

  lines.push(...drawing.grid(rows, lengths), "");

  if (option.history !== false) {
    const headers = ["service", "state", "history"].map(translate);

    const others = reports.filter((value) => {
      return value.name !== name;
    });

    const lengths = columns(headers, others, frame.length);
    const compact = lengths.length === 1;

    let titles;

    if (compact) {
      titles = [headers.join("  ")];
    } else {
      titles = headers;
    }

    const formats = titles.map(() => color.dim);
    const history = [{ values: titles, formats }];

    for (const value of others) {
      const id = value.name;
      const chosen = selected === id;

      let name;

      if (chosen) {
        name = `› ${id}`;
      } else {
        name = id;
      }

      const status = state(value, translate);
      const states = record.read(value.name).entry.states;

      let room;

      if (compact) {
        room = Math.max(1, lengths[0] - 16);
      } else {
        room = lengths[2] - 2;
      }

      const samples = states.slice(-room).join("");
      const bar = "-".repeat(room - samples.length) + samples;

      let values;

      if (compact) {
        values = [`${name} ${status} ${bar}`];
      } else {
        values = [name, status, bar];
      }

      const timeline = record.read(value.name).entry.timeline ?? [];
      const recent = timeline.slice(-room);

      let prefix;

      if (compact) {
        prefix = drawing.center(values[0], lengths[0]).indexOf(bar) + 2;
      } else {
        prefix = lengths[0] + lengths[1] + 5;
      }

      for (const [index, sample] of recent.entries()) {
        const id = `sample:${value.name}:${sample.id}`;
        const from = prefix + room - recent.length + index;
        const to = from + 1;
        const position = history.length;

        points.push({ id, position, from, to });
      }

      function tone(text) {
        return color.state(text, status.toLowerCase());
      }

      const cursor = recent.findIndex((sample) => {
        const valid = selected === `sample:${value.name}:${sample.id}`;

        return valid;
      });

      let position;

      if (cursor < 0) {
        position = -1;
      } else {
        position = room - recent.length + cursor;
      }

      function chart(text) {
        const padding = text.indexOf(bar);

        let selected;

        if (position < 0) {
          selected = -1;
        } else {
          selected = padding + position;
        }

        return color.history(text, { selected });
      }

      function focus(text) {
        if (!compact) {
          let result;

          if (chosen) {
            result = color.highlight(text);
          } else {
            result = text;
          }

          return result;
        }

        let caption;

        if (chosen) {
          caption = color.highlight(name);
        } else {
          caption = name;
        }

        const indicator = tone(status);
        const history = chart(bar);

        const value = text
          .replace(name, caption)
          .replace(status, indicator)
          .replace(bar, history);

        return value;
      }

      let formats;

      if (compact) {
        formats = [focus];
      } else {
        formats = [focus, tone, chart];
      }

      history.push({ values, formats });
    }

    const positions = [];
    const setting = { positions, heading: true };
    const offset = lines.length;

    lines.push(...drawing.grid(history, lengths, setting), "");

    for (const [index, value] of others.entries()) {
      const id = value.name;
      const row = positions[index] + offset;

      let to;

      if (compact) {
        to = drawing.width(value.name) + 5;
      } else {
        to = lengths[0] + 2;
      }

      targets.push({ id, row, from: 2, to });
    }

    for (const target of points) {
      target.row = positions[target.position - 1] + offset;

      targets.push({
        id: target.id,
        row: target.row,
        from: target.from,
        to: target.to,
      });
    }
  }

  const items = option.items?.(report) ?? [];
  const menu = screen.actions(items, translate, { selected });
  const boundary = lines.length;

  for (const target of menu.targets) {
    const id = target.id;
    const row = target.row + boundary;

    targets.push({ id, row });
  }

  lines.push(...menu.lines);

  const output = { lines, targets };

  return output;
}

export async function detail(manifest, name, translate, option = {}) {
  const record = monitor.session(option);

  async function update(setting = {}) {
    if (option.collect) {
      const reports = await option.collect(manifest, setting);

      record.record(reports);

      return;
    }

    const value = await cluster.view(manifest, {
      ...setting,
      history: option.history !== false,
    });

    record.load(value);

    record.merge(value.reports);
  }

  const controller = new globalThis.AbortController();

  function cancel() {
    controller.abort();
  }

  process.once("SIGINT", cancel);

  process.once("SIGTERM", cancel);

  try {
    const sampling = { signal: controller.signal };

    await progress.wait(() => update(sampling));

    while (input.active()) {
      function draw(selected) {
        const setting = { ...option, name, selected };

        return layout(record, translate, setting);
      }

      const setting = { update };
      const selection = await screen.page(draw, setting);

      if (selection === "0") {
        return;
      }

      if (selection.startsWith("sample:")) {
        const [, target, id] = selection.split(":");
        const entry = record.read(target).entry;

        const sample = entry.timeline.find((sample) => {
          return sample.id === id;
        });

        const events = sample?.events;

        const found = events?.find((id) =>
          entry.events.some((event) => {
            let result = event.id === id;

            if (result) {
              result = event.level !== "info";
            }

            return result;
          }),
        );

        const event = found ?? sample?.events[0];

        if (!event) {
          continue;
        }

        const history = { id: event };

        const collect = async () => {
          return await cluster.view(manifest, { history: true });
        };

        history.collect = collect;

        await logs.open(manifest, translate, { title: target, history });

        continue;
      }

      const available = record.read(name).reports;

      if (
        available.some((report) => {
          return report.name === selection;
        })
      ) {
        name = selection;

        continue;
      }

      const report = record.read(name).report;
      const items = option.items?.(report) ?? [];
      const action = items[Number(selection) - 1];

      if (action) {
        try {
          await option.action(action, report);
        } catch (failure) {
          await screen.failure(failure, translate, action);

          await screen.menu([], translate, { title: action, append: true });

          await screen.choice(["0"]);
        }

        continue;
      }

      const matches = monitor.events(report).filter((event) => {
        return event.level === selection;
      });

      if (!matches.length) {
        continue;
      }

      if (path.system()) {
        const collect = async () => {
          return await cluster.view(manifest, { history: true });
        };

        const history = { level: selection, collect };

        await logs.open(manifest, translate, { title: name, history });

        if (input.active()) {
          await progress.wait(() => update(sampling));
        }

        continue;
      }

      async function* source(signal) {
        const setting = { signal, record, collect: option.collect };
        const stream = monitor.follow(manifest, name, selection, setting);

        for await (const event of stream) {
          const rows = events.rows(event, translate);

          const lines = rows.map((text) => {
            let result;

            if (event.level === "info") {
              result = text;
            } else {
              result = color.paint(text, event.level);
            }

            return result;
          });

          yield [...lines, ""].join("\n");
        }
      }

      const title = name;
      const logging = { title, source };

      await logs.open(manifest, translate, logging);

      if (input.active()) {
        await progress.wait(() => update(sampling));
      }
    }
  } finally {
    controller.abort();

    process.removeListener("SIGINT", cancel);

    process.removeListener("SIGTERM", cancel);
  }
}

export const supporting = ["Caddy", "Vercel", "Tailscale", "TTS", "STT", "GA4"];

export function support(reports, external, translate, option = {}) {
  const caddy = reports.find((report) => {
    return report.role === "CADDY";
  });

  const local = { name: "Caddy", state: caddy?.system ?? "unknown" };

  const services = supporting.map(function service(name) {
    let result;

    if (name === "Caddy") {
      result = local;
    } else {
      result = external.find((value) => {
        return value.name === name;
      }) ?? { name, state: "" };
    }

    return result;
  });

  const states = services.map(function state(value) {
    if (!value.state) {
      return "";
    }

    let result;

    if (["active", "ready"].includes(value.state)) {
      result = "up";
    } else if (value.state === "unknown") {
      result = "";
    } else {
      result = "down";
    }

    return result;
  });

  const rows = services.map(function row(value, index) {
    let name;

    if (value.name === option.selected) {
      name = `› ${value.name}`;
    } else {
      name = value.name;
    }

    const state = states[index].toUpperCase();
    const result = [name, state];

    return result;
  });

  const headers = [translate("service"), translate("state")];
  const positions = [];

  const selected = services.findIndex((service) => {
    return service.name === option.selected;
  });

  const setting = { states, positions, selected, rounded: true };
  const lines = drawing.table(headers, rows, setting).split("\n");

  const targets = services.map(function target(service, index) {
    const id = service.name;
    const row = positions[index];
    const result = { id, row };

    return result;
  });

  const output = { lines, targets };

  return output;
}

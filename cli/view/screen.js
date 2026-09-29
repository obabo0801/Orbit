import * as timers from "node:timers";
import * as readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import * as input from "#cli/view/input.js";
import * as color from "#cli/view/color.js";
import * as drawing from "#cli/view/table.js";
import * as art from "#cli/view/logo.js";
import * as progress from "#cli/view/progress.js";
import { revision } from "#cli/view/metrics.js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

let width = drawing.span();
let skipped = false;
let navigation;

function terminal(stream = process.stdout) {
  let result = stream.isTTY === true;

  if (result) {
    result = process.env.TERM !== "dumb";
  }

  return result;
}

function interactive(stream = process.stdout) {
  let automated = process.env.CI;

  if (automated) {
    automated = process.env.CI !== "false";
  }

  let result = terminal(stream);

  if (result) {
    result = input.active();
  }

  if (result) {
    result = !automated;
  }

  return result;
}

export function columns() {
  const value = process.stdout.columns;

  let checked = Number.isFinite(value);

  if (checked) {
    checked = value >= 1;
  }

  let result;

  if (checked) {
    result = Math.floor(value);
  } else {
    result = Infinity;
  }

  return result;
}

export function clear() {
  width = drawing.span();
  skipped = false;
  navigation = undefined;

  if (!interactive()) {
    return;
  }

  readline.cursorTo(process.stdout, 0, 0);

  readline.clearScreenDown(process.stdout);
}

export function separator() {
  width = drawing.span();

  const line = drawing.glyphs.horizontal.repeat(width);

  console.log(drawing.border(line));
}

export function heading() {
  width = drawing.span();

  const separator = drawing.border(drawing.glyphs.horizontal.repeat(width));
  const logo = [...art.logo];
  const last = logo.length - 1;
  const companion = art.dog.join("");

  logo[last] = logo[last].trimEnd() + " " + companion;

  const size = Math.max(...logo.map(drawing.width));
  const lines = [separator];

  for (const line of logo) {
    const padding = " ".repeat(size - drawing.width(line));
    const clipped = drawing.clip(line + padding, width);
    const centered = drawing.center(clipped, width);

    lines.push(color.gradient(centered));
  }

  lines.push(separator);

  return lines;
}

export function banner() {
  console.log(heading().join("\n"));
}

export async function write(text, option = {}) {
  const {
    format = String,
    prefix = "",
    stream = process.stdout,
    suffix = "",
  } = option;

  const pieces = Array.from(segments.segment(text), function piece(part) {
    return part.segment;
  });

  let continuous = !text.includes("\n");

  if (continuous) {
    continuous = pieces.length <= 80;
  }

  const animated = interactive(stream);
  const interval = Math.min(3, 120 / Math.max(pieces.length, 1));

  stream.write(prefix);

  let answer = !animated;

  if (!answer) {
    answer = !continuous;
  }

  if (!answer) {
    answer = skipped;
  }

  if (answer) {
    stream.write(format(text) + suffix + "\n");

    return;
  }

  let finish;

  const interrupted = new Promise(function wait(resolve) {
    finish = resolve;
  });

  const release = input.effect(function skip() {
    skipped = true;

    finish();
  });

  try {
    for (let index = 0; index < pieces.length; index++) {
      if (skipped) {
        stream.write(format(pieces.slice(index).join("")));

        break;
      }

      stream.write(format(pieces[index]));

      const waiting = delay(interval);

      await Promise.race([waiting, interrupted]);
    }

    stream.write(suffix + "\n");
  } finally {
    release();
  }
}

export async function menu(items, translate, option = {}) {
  const {
    exit = "back",
    title = "",
    value,
    key,
    append = false,
    content,
  } = option;

  if (!append) {
    await progress.wait(async function prepare() {});
  }

  if (content) {
    await content();
  }

  const labels = items.map(function label(item, index) {
    const text = `${index + 1}. ${translate(item)}`;

    return text;
  });

  const last = `0. ${translate(exit)}`;
  const status = value ?? "";
  const selectable = interactive();
  const entries = [...labels, last];

  let menus;

  if (selectable) {
    menus = entries.map(function item(text) {
      const result = "  " + text;

      return result;
    });
  } else {
    menus = entries;
  }

  const available = process.stdout.columns;

  let columns;

  if (available > 0) {
    columns = available;
  } else {
    columns = 80;
  }

  const heading = translate(title);
  const layout = { columns };
  const frame = drawing.frame(heading, layout);

  width = Math.max(width, frame.length);

  console.log(drawing.border(frame.top));

  if (value !== undefined) {
    function state(value) {
      return color.selection(value, key);
    }

    console.log(frame.row(status, state));

    console.log(drawing.border(frame.divide));
  }

  for (const text of menus) {
    const cell = frame.parts(text);

    let start;

    if (selectable) {
      start = 2;
    } else {
      start = 0;
    }

    const number = text.indexOf(" ", start) + 1;
    const prefix = cell.prefix + color.paint(cell.text.slice(0, number), "dim");
    const content = cell.text.slice(number);
    const suffix = cell.suffix;
    const setting = { prefix, suffix };

    await write(content, setting);
  }

  console.log(drawing.border(frame.bottom));

  if (interactive()) {
    readline.moveCursor(process.stdout, 0, -1);

    readline.cursorTo(process.stdout, 0);

    navigation = { frame, entries, position: undefined };

    focus(0);
  } else {
    navigation = undefined;
  }
}

function focus(position) {
  if (!navigation) {
    return;
  }

  const { frame, entries } = navigation;

  function row(index, selected) {
    let marker;

    if (selected) {
      marker = "› ";
    } else {
      marker = "  ";
    }

    const cell = frame.parts(marker + entries[index]);
    const number = cell.text.indexOf(" ", 2) + 1;
    const label = color.paint(cell.text.slice(0, number), "dim");
    const ordinary = label + cell.text.slice(number) + cell.padding;

    let line;

    if (selected) {
      line = frame.highlight(marker + entries[index]);
    } else {
      line = cell.prefix + ordinary + cell.ending;
    }

    const distance = entries.length - index;

    readline.moveCursor(process.stdout, 0, -distance);

    readline.cursorTo(process.stdout, 0);

    process.stdout.write(line);

    readline.moveCursor(process.stdout, 0, distance);

    readline.cursorTo(process.stdout, 0);
  }

  if (navigation.position !== undefined) {
    row(navigation.position, false);
  }

  row(position, true);

  navigation.position = position;
}

export async function choice(values) {
  const cursor = Boolean(navigation);
  const mouse = cursor;
  const width = navigation?.frame.length;
  const rows = navigation?.entries.length;
  const option = { change: focus, cursor, mouse, width, rows };

  try {
    return await input.choice(values, option);
  } finally {
    navigation = undefined;

    if (cursor) {
      readline.moveCursor(process.stdout, 0, 1);

      readline.cursorTo(process.stdout, 0);
    }

    skipped = false;
  }
}

export async function result(title, lines, option = {}) {
  const stream = option.stream ?? process.stdout;
  const tone = option.tone ?? "success";
  const frame = drawing.frame(title);

  stream.write(drawing.border(frame.top) + "\n");

  function format(value) {
    let result;

    if (option.format) {
      result = option.format(value);
    } else {
      result = color.paint(value, tone, stream);
    }

    return result;
  }

  for (const line of lines) {
    const rows = drawing.wrap(line, frame.content);

    for (const row of rows) {
      const cell = frame.parts(row);
      const prefix = cell.prefix;
      const suffix = cell.suffix;
      const setting = { prefix, suffix, format, stream };

      await write(cell.text, setting);
    }
  }

  stream.write(drawing.border(frame.bottom) + "\n");
}

export async function message(code, translate, operation) {
  const outcomes = {
    install: "installed",
    uninstall: "uninstalled",
    start: "started",
    stop: "stopped",
    restart: "restarted",
  };

  let outcome;

  if (code === "complete") {
    outcome = outcomes[operation] ?? code;
  } else {
    outcome = code;
  }

  const text = translate(outcome);
  const positive = ["preference", "complete"].includes(code);
  const caution = ["pending", "skipped", "changed", "mount"].includes(code);

  let heading = "failure";

  if (positive) {
    heading = "done";
  } else if (caution) {
    heading = code;
  }

  const title = translate(heading);

  function format(value) {
    return color.result(value, code);
  }

  const option = { format };

  await result(title, [text], option);
}

export async function warning(text) {
  await result(text, [text], { tone: "warning" });
}

export async function failure(fault, translate, operation = "operation") {
  let title;

  if (operation === "network") {
    title = "Network";
  } else {
    title = translate(operation);
  }

  const heading = `${title} ${translate("failure")}`;

  let message;

  if (typeof fault.message === "string") {
    message = fault.message;
  } else {
    message = "";
  }

  const identity = message.match(/^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/u)?.[1];

  const reasons = {
    OWNER: "permission",
    CONFIG: "config",
    TOKEN: "config",
    NODE: "config",
    LOCAL: "config",
    SERVICE: "config",
    DUPLICATE: "collision",
  };

  const messages = {
    UPDATE_FETCH: "fetch",
    UPDATE_SSH: "ssh",
    UPDATE_ACCESS: "access",
    UPDATE_INPUT: "input",
    UPDATE_RESPONSE: "response",
    UPDATE_TRANSPORT: "transport",
    UPDATE_ABORT: "abort",
    UPDATE_TIMEOUT: "timeout",
  };

  let code = fault.code ?? "internal";

  if (identity) {
    const reason = identity.split("_").at(-1);

    code = messages[identity] ?? reasons[reason] ?? code;
  }

  const translated = translate(code);

  let native = translated === code;

  if (native) {
    native = typeof fault.message === "string";
  }

  let detail;

  const concise = ["UPDATE_DIVERGED", "UPDATE_PENDING"].includes(identity);

  if (concise) {
    detail = `[${identity}]`;
  } else if (identity) {
    let description;

    if (native) {
      description = translate("internal");
    } else {
      description = translated;
    }

    detail = `[${identity}] ${description}`;
  } else {
    if (native) {
      detail = fault.message;
    } else {
      detail = translated;
    }
  }

  const lines = [detail];

  if (fault.reason) {
    const reason = translate(fault.reason);

    let cause;

    if (fault.target) {
      cause = `[${reason}] ${revision(fault.target)}`;
    } else {
      cause = reason;
    }

    lines.push(cause);
  }

  if (fault.guide) {
    const guide = translate(fault.guide);

    if (Array.isArray(guide)) {
      lines.push(...guide);
    }
  }

  let valid = typeof fault.diagnostic === "string";

  if (valid) {
    valid = fault.diagnostic.trim();
  }

  if (valid) {
    valid = !identity;
  }

  if (valid) {
    const diagnostic = stripVTControlCharacters(fault.diagnostic).trim();

    lines.push(...diagnostic.split(/\r?\n/));
  }

  const stream = process.stderr;
  const option = { tone: "error", stream };

  await result(heading, lines, option);
}

export async function page(draw, option = {}) {
  await progress.wait(async function prepare() {});

  let selected = option.selected ?? "";
  let timer;
  let pending;
  let closed = false;

  const controller = new globalThis.AbortController();

  let layout;
  let positions;
  let bounds;

  function render() {
    const aborted = input.signal.aborted;
    const blocked = closed || aborted;

    if (blocked) {
      return;
    }

    clear();

    layout = draw(selected);

    layout.targets.sort(function order(left, right) {
      let result = left.row - right.row;

      if (!result) {
        result = (left.from ?? 0) - (right.from ?? 0);
      }

      return result;
    });

    const rows = process.stdout.rows;

    let limited = Number.isInteger(rows);

    if (limited) {
      limited = rows > 1;
    }

    let height;

    if (limited) {
      height = rows - 1;
    } else {
      height = layout.lines.length;
    }

    const target = layout.targets.find((target) => {
      return target.id === selected;
    });

    const value = target?.row ?? layout.targets[0]?.row;
    const focus = value ?? 0;
    const maximum = Math.max(0, layout.lines.length - height);
    const centered = Math.max(0, focus - Math.floor(height / 2));
    const start = Math.min(maximum, centered);
    const visible = layout.lines.slice(start, start + height);

    console.log(visible.join("\n"));

    positions = layout.targets.map((target) => {
      const text = visible.length - target.row + start;

      return text;
    });
    bounds = layout.targets.map(function boundary(target) {
      if (target.from === undefined) {
        return undefined;
      }

      const from = target.from;
      const to = target.to;
      const result = { from, to };

      return result;
    });

    let width;

    if (option.full) {
      width = columns();
    } else {
      width = drawing.span();
    }

    const values = layout.targets.map((target) => target.id);

    const passive = layout.targets
      .filter((target) => target.passive)
      .map((target) => target.id);

    const setting = { positions, width, bounds, values, passive };

    input.layout(setting);

    layout.start = start;
    layout.height = visible.length;
    layout.passive = passive;
  }

  function change(index) {
    selected = layout.targets[index]?.id ?? "";

    render();
  }

  async function sample() {
    try {
      const setting = { signal: controller.signal };

      await option.update(setting);

      render();
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
    }

    if (!closed) {
      timer = timers.setTimeout(tick, option.interval ?? 5000);
    }
  }

  function tick() {
    pending = sample();

    pending.catch(function failure(error) {
      closed = true;

      input.close();

      process.stderr.write(error.message + "\n");
    });
  }

  render();

  const active = interactive();

  if (!active) {
    return "0";
  }

  selected ||= layout.targets[0]?.id ?? "0";

  render();

  const values = layout.targets.map((target) => target.id);

  let width;

  if (option.full) {
    width = columns();
  } else {
    width = drawing.span();
  }

  const back = option.back;
  const passive = layout.passive;

  if (back === false) {
    values.push("0");
  }

  const setting = {
    change,
    cursor: true,
    mouse: true,
    positions,
    width,
    back,
    bounds,
    latest: option.latest,
    passive,
    selected,
  };

  process.stdout.on("resize", render);

  if (option.update) {
    timer = timers.setTimeout(tick, option.interval ?? 5000);
  }

  try {
    return await input.choice(values, setting);
  } finally {
    closed = true;

    timers.clearTimeout(timer);

    controller.abort();

    process.stdout.removeListener("resize", render);

    await pending;
  }
}

export function actions(items, translate, option = {}) {
  const frame = drawing.frame(option.title ?? "");
  const lines = [drawing.border(frame.top)];
  const targets = [];
  const exit = option.exit ?? "back";

  for (const [index, item] of [...items, exit].entries()) {
    let id;

    if (index === items.length) {
      id = "0";
    } else {
      id = String(index + 1);
    }

    const selected = option.selected === id;

    let marker;

    if (selected) {
      marker = "› ";
    } else {
      marker = "  ";
    }

    const label = `${marker}${id}. ${translate(item)}`;
    const cell = frame.parts(label);
    const boundary = cell.text.indexOf(" ", 2) + 1;
    const number = color.paint(cell.text.slice(0, boundary), "dim");
    const ordinary = number + cell.text.slice(boundary) + cell.padding;
    const row = lines.length;

    targets.push({ id, row });

    let line;

    if (selected) {
      line = frame.highlight(label);
    } else {
      line = cell.prefix + ordinary + cell.ending;
    }

    lines.push(line);
  }

  lines.push(drawing.border(frame.bottom));

  const result = { lines, targets };

  return result;
}

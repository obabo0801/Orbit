import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import * as timers from "node:timers";

let waiting;
let opened = false;
let skipping;
let raw;
let hidden = false;
let tracking = false;
let sequence = "";
let timer;
let decoder;
let cancellation;

const controller = new globalThis.AbortController();

export const signal = controller.signal;

const modes = {
  mouse: "\u001b[?1003h\u001b[?1006h",
  release: "\u001b[?1003l\u001b[?1000l\u001b[?1006l",
  hide: "\u001b[?25l",
  show: "\u001b[?25h",
  position: "\u001b[6n",
};

function restore() {
  if (tracking) {
    process.stdout.write(modes.release);
  }

  if (hidden) {
    process.stdout.write(modes.show);
  }

  tracking = false;
  hidden = false;
}

function controls(setting) {
  if (!setting.cursor) {
    return;
  }

  hidden = true;

  process.stdout.write(modes.hide);

  if (setting.mouse) {
    waiting.probe = true;

    process.stdout.write(modes.position);
  }
}

function finish(value) {
  const pending = waiting;

  if (!pending) {
    return;
  }

  waiting = undefined;

  restore();

  pending.decoder.removeAllListeners("keypress");

  pending.decoder.destroy();

  pending.resolve(value);
}

function select(value) {
  finish(value);
}

function position(report) {
  let valid = !waiting?.probe;

  if (!valid) {
    valid = Number(report[2]) !== 1;
  }

  if (valid) {
    return;
  }

  waiting.probe = false;
  waiting.origin = Number(report[1]);

  if (!waiting.positions) {
    waiting.origin -= waiting.rows;
  }

  tracking = true;

  process.stdout.write(modes.mouse);
}

function pointer(report) {
  let valid = !tracking;

  if (!valid) {
    valid = waiting?.kind !== "menu";
  }

  if (valid) {
    return;
  }

  const button = Number(report[1]);
  const column = Number(report[2]);
  const row = Number(report[3]);
  const distance = waiting.origin - row;
  const wheel = (button & 64) !== 0;

  if (wheel) {
    const direction = button & 3;
    const vertical = direction < 2;
    const pressed = report[4] === "M";
    const moving = vertical && pressed;

    if (moving) {
      let name;

      if (direction === 0) {
        name = "up";
      } else {
        name = "down";
      }

      menu(undefined, { name, ctrl: false });
    }

    return;
  }

  const moving = (button & 32) !== 0;

  let index;

  if (waiting.positions) {
    index = waiting.positions.findIndex(function target(position, index) {
      const bounds = waiting.bounds?.[index];

      let inside = !bounds;

      if (!inside) {
        const from = column >= bounds.from;

        let within;

        if (from) {
          within = column < bounds.to;
        }

        inside = from && within;
      }

      const equal = position === distance;
      const result = equal && inside;

      return result;
    });
  } else {
    index = row - waiting.origin;
  }

  let inside = column > 1;

  if (inside) {
    inside = column < waiting.width;
  }

  let item = index >= 0;

  if (item) {
    item = index < waiting.order.length;
  }

  if (item) {
    item = !waiting.passive?.includes(waiting.order[index]);
  }

  const eligible = inside && item;

  if (moving) {
    const pressed = report[4] === "M";
    const changed = index !== waiting.position;
    const update = eligible && pressed && changed;

    if (update) {
      waiting.position = index;

      waiting.change?.(index);
    }

    return;
  }

  let pressed = button === 0;

  if (pressed) {
    pressed = report[4] === "M";
  }

  if (eligible && pressed) {
    select(waiting.order[index]);
  }
}

function decode(text) {
  const pending = waiting;

  if (!pending) {
    return;
  }

  while (true) {
    let report = text;

    if (report) {
      report = waiting === pending;
    }

    if (!report) {
      break;
    }

    const start = text.indexOf("\u001b");

    if (start === -1) {
      waiting?.decoder.write(text);

      return;
    }

    if (start > 0) {
      waiting?.decoder.write(text.slice(0, start));

      if (waiting !== pending) {
        return;
      }

      text = text.slice(start);
    }

    const control = text.slice(1);
    const mouse = control.match(/^\[<(\d+);(\d+);(\d+)([Mm])/);
    const cursor = control.match(/^\[\??(\d+);(\d+)R/);

    if (mouse || cursor) {
      if (mouse) {
        pointer(mouse);
      } else {
        position(cursor);
      }

      text = text.slice((mouse ?? cursor)[0].length + 1);

      continue;
    }

    const legacy = control.startsWith("[M");

    let valid = legacy;

    if (valid) {
      valid = control.length >= 5;
    }

    if (valid) {
      text = text.slice(6);

      continue;
    }

    const absent = !control;

    let partial = absent || legacy;

    if (!partial) {
      partial = /^\[(?:<[\d;]*|\??[\d;]*)$/.test(control);
    }

    if (partial) {
      sequence = text;

      let timeout;

      if (!control) {
        timeout = 50;
      } else {
        timeout = 500;
      }

      timer = timers.setTimeout(function flush() {
        const buffered = sequence;

        sequence = "";

        let valid = waiting === pending;

        if (valid) {
          valid = buffered === "\u001b";
        }

        if (valid) {
          waiting.decoder.write(buffered);
        }
      }, timeout);

      return;
    }

    waiting?.decoder.write(text[0]);

    text = text.slice(1);
  }
}

function menu(text, key) {
  let valid = key.ctrl;

  if (valid) {
    valid = key.name === "c";
  }

  if (valid) {
    interrupt();

    return;
  }

  if (key.name === "escape") {
    select("0");

    return;
  }

  const horizontal = waiting.bounds?.[waiting.position] !== undefined;

  let up = key.name === "up";

  if (!up) {
    let left;

    if (horizontal) {
      left = key.name === "left";
    }

    up = horizontal && left;
  }

  let down = key.name === "down";

  if (!down) {
    let right;

    if (horizontal) {
      right = key.name === "right";
    }

    down = horizontal && right;
  }

  if (up || down) {
    const count = waiting.order.length;

    let step;

    if (up) {
      step = -1;
    } else {
      step = 1;
    }

    let position = (waiting.position + step + count) % count;
    let prepared = key.name === "left";

    if (!prepared) {
      prepared = key.name === "right";
    }

    if (prepared) {
      const row = waiting.positions[waiting.position];

      const indices = waiting.bounds.flatMap((bounds, index) => {
        let checked;

        if (bounds) {
          checked = waiting.positions[index] === row;
        }

        let accepted = bounds && checked;

        if (accepted) {
          accepted = !waiting.passive?.includes(waiting.order[index]);
        }

        let result;

        if (accepted) {
          result = [index];
        } else {
          result = [];
        }

        return result;
      });

      const index = indices.indexOf(waiting.position);

      position = indices[(index + step + indices.length) % indices.length];
    }

    const completion = waiting.positions;

    let matching;

    if (completion) {
      let found = key.name === "up";

      if (!found) {
        found = key.name === "down";
      }

      matching = found;
    }

    const eligible = completion && matching;

    if (eligible) {
      const row = waiting.positions[waiting.position];

      for (let attempt = 0; attempt < count; attempt++) {
        let complete = !waiting.passive?.includes(waiting.order[position]);

        if (complete) {
          complete = waiting.positions[position] !== row;
        }

        if (complete) {
          break;
        }

        position = (position + step + count) % count;
      }

      const destination = waiting.positions[position];

      const first = waiting.order.findIndex(function target(value, index) {
        let result = !waiting.passive?.includes(value);

        if (result) {
          result = waiting.positions[index] === destination;
        }

        return result;
      });

      if (first >= 0) {
        position = first;
      }
    }

    waiting.position = position;

    waiting.change?.(waiting.position);
  } else if (["return", "enter"].includes(key.name)) {
    select(waiting.order[waiting.position]);
  } else {
    let compatible = key.name === "end";

    if (compatible) {
      compatible = waiting.latest;
    }

    if (compatible) {
      const index = waiting.order.indexOf(waiting.latest);

      if (index >= 0) {
        waiting.position = index;

        waiting.change?.(index);
      }
    } else if (waiting.values.includes(text)) {
      select(text);
    }
  }
}

function read(buffer) {
  timers.clearTimeout(timer);

  const text = sequence + decoder.write(buffer);

  sequence = "";

  if (text.includes("\u0003")) {
    interrupt();

    return;
  }

  if (skipping) {
    const complete = skipping;

    skipping = undefined;

    complete();

    return;
  }

  decode(text);
}

function interrupt() {
  if (cancellation) {
    cancellation();

    return;
  }

  stop();

  process.emit("SIGINT");
}

function request(setting) {
  if (waiting || skipping) {
    throw new Error("INPUT_LOCK: Input is busy.");
  }

  const result = new Promise(function wait(resolve) {
    const decoder = new PassThrough();

    readline.emitKeypressEvents(decoder);

    waiting = { ...setting, decoder, resolve };

    decoder.on("keypress", function keypress(text, key) {
      if (waiting?.decoder !== decoder) {
        return;
      }

      menu(text, key);
    });

    controls(setting);
  });

  return result;
}

export function open() {
  if (signal.aborted) {
    return;
  }

  let valid = opened;

  if (!valid) {
    valid = !process.stdin.isTTY;
  }

  if (valid) {
    return;
  }

  opened = true;
  raw = process.stdin.isRaw;
  decoder = new StringDecoder("utf8");

  process.stdin.setRawMode(true);

  process.stdin.on("data", read);

  process.stdin.on("end", close);

  process.on("exit", close);

  process.stdin.ref?.();

  process.stdin.resume();
}

export function close() {
  cancellation?.();

  restore();

  if (!opened) {
    return;
  }

  if (skipping) {
    const complete = skipping;

    skipping = undefined;

    complete();
  }

  if (waiting) {
    finish("0");
  }

  process.stdin.removeListener("data", read);

  process.stdin.removeListener("end", close);

  process.removeListener("exit", close);

  timers.clearTimeout(timer);

  sequence = "";

  process.stdin.setRawMode(raw === true);

  process.stdin.pause();

  process.stdin.unref?.();

  opened = false;
}

export function stop() {
  if (!signal.aborted) {
    controller.abort();
  }

  close();
}

export function active() {
  return opened;
}

export function effect(finish) {
  skipping = finish;

  const result = function release() {
    if (skipping === finish) {
      skipping = undefined;
    }
  };

  return result;
}

export function choice(values, option = {}) {
  if (!opened) {
    return Promise.resolve("0");
  }

  const entries = values.filter(function item(value) {
    return value !== "0";
  });

  let order;

  if (option.back === false) {
    order = entries;
  } else {
    order = [...entries, "0"];
  }

  const change = option.change;
  const cursor = option.cursor ?? false;
  const mouse = option.mouse ?? false;
  const width = option.width;
  const rows = option.rows;
  const positions = option.positions;
  const bounds = option.bounds;

  const setting = {
    kind: "menu",
    values,
    order,
    change,
    position: Math.max(0, order.indexOf(option.selected)),
    cursor,
    mouse,
    width,
    rows,
    positions,
    bounds,
    latest: option.latest,
    passive: option.passive,
  };

  return request(setting);
}

export function cursor(visible = true) {
  let valid = !opened;

  if (!valid) {
    valid = !process.stdout.isTTY;
  }

  if (valid) {
    return;
  }

  hidden = !visible;

  let visibility;

  if (visible) {
    visibility = modes.show;
  } else {
    visibility = modes.hide;
  }

  process.stdout.write(visibility);
}

export function layout(option) {
  if (waiting?.kind !== "menu") {
    return;
  }

  waiting.positions = option.positions;
  waiting.width = option.width;
  waiting.bounds = option.bounds;
  waiting.passive = option.passive;

  if (option.values) {
    const selected = waiting.order[waiting.position];

    waiting.values = option.values;
    waiting.order = option.values;
    waiting.position = Math.max(0, waiting.order.indexOf(selected));
  }

  if (tracking) {
    process.stdout.write(modes.release);
  }

  tracking = false;
  waiting.probe = true;

  process.stdout.write(modes.position);
}

export function dismiss() {
  finish("0");
}

export function intercept(cancel) {
  if (cancellation || waiting || skipping) {
    throw new Error("INPUT_LOCK: Input is busy.");
  }

  cancellation = cancel;

  const result = function release() {
    if (cancellation === cancel) {
      cancellation = undefined;
    }
  };

  return result;
}

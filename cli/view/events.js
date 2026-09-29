import * as archive from "#cli/core/record.js";
import * as input from "#cli/view/input.js";
import * as screen from "#cli/view/screen.js";
import * as drawing from "#cli/view/table.js";
import * as color from "#cli/view/color.js";
import * as time from "#cli/view/time.js";

function message(event, translate) {
  const messages = translate("event");

  let positive = event.value === true;

  if (!positive) {
    positive = ["ready", "active"].includes(event.value);
  }

  if (event.check === "operation") {
    const result = messages[event.summary] ?? messages.observed;

    return result;
  }

  if (["cpu", "memory", "disk"].includes(event.check)) {
    let key;

    if (["warning", "error"].includes(event.level)) {
      key = event.level;
    } else {
      key = "normal";
    }

    const name = translate(event.check);
    const message = messages[key].replace("{name}", name);

    let amount;

    if (Number.isFinite(event.amount)) {
      amount = ` (${event.amount.toFixed(1)}%)`;
    } else {
      amount = "";
    }

    const text = message + amount;

    return text;
  }

  if (event.check === "database") {
    let key;

    if (event.level === "error") {
      key = "disconnected";
    } else if (event.level === "success") {
      key = "connected";
    } else if (positive) {
      key = "database";
    } else {
      key = "unavailable";
    }

    return messages[key];
  }

  if (event.check === "system") {
    let key;

    if (event.level === "error") {
      key = "fault";
    } else if (event.value === "inactive") {
      key = "stopped";
    } else if (event.level === "success") {
      key = "started";
    } else {
      key = "observed";
    }

    return messages[key];
  }

  if (event.value === "unconfigured") {
    return messages.unconfigured;
  }

  if (event.check === "readiness") {
    let valid = event.level === "error";

    if (!valid) {
      valid = !positive;
    }

    if (valid) {
      return messages.unready;
    }

    return messages.prepared;
  }

  if (event.level === "warning") {
    let status;

    if (event.check === "latency") {
      status = "slow";
    } else {
      status = "preparing";
    }

    const received = messages[status];

    return received;
  }

  if (event.level === "error") {
    return messages.lost;
  }

  if (event.level === "success") {
    let recovery = event.check === "liveness";

    if (!recovery) {
      recovery = event.check === "readiness";
    }

    let key;

    if (recovery) {
      key = "recovered";
    } else {
      key = "external";
    }

    return messages[key];
  }

  let answer;

  if (positive) {
    answer = "response";
  } else {
    answer = "unanswered";
  }

  const completion = messages[answer];

  return completion;
}

function prefix(event) {
  const stamp = time.format(event.time);
  const level = event.level.toUpperCase();
  const text = `${stamp} [${level}] [${event.name}] `;

  return text;
}

export function line(event, translate) {
  const text = prefix(event) + message(event, translate);

  return text;
}

export function rows(event, translate, option = {}) {
  const length = option.width ?? screen.columns();
  const text = line(event, translate);
  const setting = { words: true };

  return drawing.wrap(text, length, setting);
}

export async function open(name, translate, option = {}) {
  let snapshot;
  let selected = option.id ?? "latest";
  let closed = false;

  async function update() {
    let value;

    if (option.collect) {
      value = await option.collect();
    } else {
      value = await archive.latest({ stale: true });
    }

    if (value) {
      snapshot = value;
    }
  }

  await update();

  function entries() {
    const entry = snapshot?.entries.find(([key]) => {
      return key === name;
    })?.[1];

    const events = entry?.events ?? [];

    let result;

    if (option.level) {
      result = events.filter((event) => {
        return event.level === option.level;
      });
    } else {
      result = events;
    }

    return result;
  }

  let answer = option.id;

  if (answer) {
    answer = !entries().some((event) => {
      return event.id === option.id;
    });
  }

  if (answer) {
    const fault = new Error("HISTORY_EXPIRED: History event has expired.");

    fault.code = "expired";

    throw fault;
  }

  function cancel() {
    closed = true;

    input.dismiss();
  }

  const release = input.intercept(cancel);

  try {
    while (true) {
      let prepared = input.active();

      if (prepared) {
        prepared = !closed;
      }

      if (!prepared) {
        break;
      }

      function draw(focus) {
        const lines = [];
        const targets = [];

        for (const event of entries()) {
          const row = lines.length;

          targets.push({ id: event.id, row });

          function format(text) {
            let result;

            if (focus === event.id) {
              result = color.highlight(text);
            } else if (event.level === "info") {
              result = text;
            } else {
              result = color.paint(text, event.level);
            }

            return result;
          }

          const wrapped = rows(event, translate);

          lines.push(...wrapped.map(format));
        }

        const row = lines.length;

        targets.push({ id: "latest", row });

        const output = { lines, targets };

        return output;
      }

      const setting = {
        full: true,
        update,
        interval: 1000,
        selected,
        latest: "latest",
        back: false,
      };

      const value = await screen.page(draw, setting);

      if (value === "0") {
        return;
      }

      selected = value;
    }
  } finally {
    release();
  }
}

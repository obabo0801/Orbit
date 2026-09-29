import * as timers from "node:timers";
import * as drawing from "#cli/view/table.js";
import * as color from "#cli/view/color.js";
import * as screen from "#cli/view/screen.js";
import * as input from "#cli/view/input.js";
import { locale } from "#cli/core/locale.js";

const symbols = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

export function bar(ratio, width) {
  const fraction = Math.max(0, Math.min(ratio, 1));
  const filled = Math.floor(width * fraction);
  const text = "█".repeat(filled) + "░".repeat(width - filled);

  return text;
}

export async function open(language = "auto", option = {}) {
  let translate;

  if (option.compact) {
    translate = (name) => name;
  } else {
    translate = await locale({ language });
  }

  const labels = translate("progress");
  const operation = option.operation ?? "install";
  const owned = !input.active();

  if (owned) {
    input.open();
  }

  let automated = process.env.CI;

  if (automated) {
    automated = process.env.CI !== "false";
  }

  let istty = input.active();

  if (istty) {
    istty = process.stdout.isTTY;
  }

  let absent;

  if (istty) {
    absent = !automated;
  }

  const interactive = istty && absent;
  const completed = new Set();

  let stages = [];
  let stage = "preparation";
  let state = "running";
  let position = 0;
  let paused = false;
  let timer;

  function render() {
    let blocked = !interactive;

    if (!blocked) {
      blocked = paused;
    }

    if (!blocked) {
      blocked = !input.active();
    }

    if (blocked) {
      return;
    }

    screen.clear();

    input.cursor(false);

    if (option.compact) {
      console.log(color.gradient(symbols[position]));

      return;
    }

    let names;

    if (stages.length) {
      names = stages;
    } else {
      names = [stage];
    }

    const rows = names.map(function row(name) {
      const finished = completed.has(name);

      let active = stage === name;

      if (active) {
        active = !finished;
      }

      let symbol = " ";

      if (finished) {
        symbol = "✓";
      } else if (active) {
        if (state === "failed") {
          symbol = "×";
        } else {
          symbol = symbols[position];
        }
      }

      const text = `${symbol} ${labels[name] ?? name}`;

      let format;

      if (finished) {
        format = (value) => color.paint(value, "success");
      } else {
        let following;

        if (active) {
          following = state === "failed";
        }

        const valid = active && following;

        if (valid) {
          format = (value) => color.paint(value, "error");
        } else if (active) {
          format = color.gradient;
        } else {
          format = (value) => color.paint(value, "dim");
        }
      }

      const output = { text, format };

      return output;
    });

    const frame = drawing.frame(translate(operation));

    console.log(drawing.border(frame.top));

    for (const row of rows) {
      console.log(frame.row(row.text, row.format));
    }

    if (stages.length) {
      const count = `${completed.size}/${stages.length}`;
      const length = Math.max(1, frame.content - drawing.width(count) - 2);
      const ratio = completed.size / stages.length;
      const blocks = bar(ratio, length);
      const text = `${blocks}  ${count}`;

      console.log(drawing.border(frame.divide));

      console.log(frame.row(text, color.gradient));
    }

    console.log(drawing.border(frame.bottom));
  }

  function stop() {
    timers.clearInterval(timer);

    timer = undefined;
  }

  function resume() {
    if (input.signal.aborted) {
      return;
    }

    paused = false;

    render();

    let following;

    if (interactive) {
      following = state === "running";
    }

    let pending = interactive && following;

    if (pending) {
      pending = !timer;
    }

    if (pending) {
      timer = timers.setInterval(function tick() {
        position = (position + 1) % symbols.length;

        render();
      }, 120);

      timer.unref();
    }
  }

  function pause() {
    paused = true;

    stop();

    if (interactive) {
      input.cursor(true);

      screen.clear();
    }
  }

  function update(event) {
    if (event.stages) {
      stages = event.stages;
    }

    if (event.name) {
      stage = event.name;
    }

    state = event.state;

    if (state === "complete") {
      completed.add(stage);
    }

    if (state === "failed") {
      completed.delete(stage);
    }

    if (state !== "running") {
      stop();
    }

    if (!interactive) {
      const label = labels[stage] ?? stage;

      const outcomes = {
        running: "activating",
        complete: "complete",
        failed: "failed",
      };

      const outcome = translate(outcomes[state]);

      console.log(`${label}: ${outcome}`);
    }

    resume();
  }

  function close() {
    stop();

    paused = true;

    if (interactive) {
      input.cursor(true);
    }

    if (owned) {
      input.close();
    }

    input.signal.removeEventListener("abort", close);
  }

  input.signal.addEventListener("abort", close, { once: true });

  const result = { update, pause, resume, close };

  return result;
}

export async function wait(work, language = "auto") {
  const display = await open(language, { compact: true });

  display.resume();

  try {
    input.signal.throwIfAborted();

    return await work(input.signal);
  } finally {
    display.close();

    screen.clear();
  }
}

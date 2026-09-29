import * as input from "#cli/view/input.js";
import * as screen from "#cli/view/screen.js";
import { execute } from "#cli/core/service.js";
import { units } from "#cli/core/system.js";
import * as time from "#cli/view/time.js";
import * as events from "#cli/view/events.js";
import * as color from "#cli/view/color.js";
import * as journal from "#cli/core/journal.js";
import * as progress from "#cli/view/progress.js";

export async function open(manifest, translate, option = {}) {
  try {
    return await follow(manifest, translate, option);
  } catch (failure) {
    if (!input.active()) {
      throw failure;
    }

    await screen.failure(failure, translate, "logs");

    const setting = { title: "logs", append: true };

    await screen.menu([], translate, setting);

    await screen.choice(["0"]);
  }
}

async function follow(manifest, translate, option) {
  if (option.history) {
    return events.open(option.title, translate, option.history);
  }

  await progress.wait(async function prepare() {
    if (!option.cursor) {
      return;
    }

    const service = units(manifest.services)[0];
    const setting = { cursor: option.cursor };

    await journal.entries(service, setting);
  });

  const controller = new globalThis.AbortController();
  const owned = !input.active();

  if (owned) {
    input.open();
  }

  function cancel() {
    controller.abort();
  }

  const release = input.intercept(cancel);

  process.once("SIGINT", cancel);

  process.once("SIGTERM", cancel);

  screen.clear();

  const signal = controller.signal;
  const source = option.source?.(signal);

  function format(line) {
    if (!option.cursor) {
      return time.journal(line);
    }

    const entry = JSON.parse(line);
    const stamp = time.format(Number(entry.__REALTIME_TIMESTAMP) / 1000);

    let message;

    if (typeof entry.MESSAGE === "string") {
      message = entry.MESSAGE;
    } else {
      message = "";
    }

    const text = `${stamp} ${message}`;

    let result;

    if (entry.__CURSOR === option.cursor) {
      result = color.highlight(text);
    } else {
      result = text;
    }

    return result;
  }

  const cursor = option.cursor;
  const setting = { signal, source, format, cursor };

  try {
    await execute("logs", manifest, setting);
  } catch (failure) {
    const aborted = signal.aborted;
    const cancelled = failure.name === "AbortError";
    const expected = aborted && cancelled;

    if (!expected) {
      throw failure;
    }
  } finally {
    controller.abort();

    release();

    process.removeListener("SIGINT", cancel);

    process.removeListener("SIGTERM", cancel);

    if (owned) {
      input.close();
    }
  }
}

import * as update from "#cli/core/update.js";
import * as git from "#cli/core/git.js";
import * as progress from "#cli/view/progress.js";
import * as screen from "#cli/view/screen.js";
import * as input from "#cli/view/input.js";
import { locale } from "#cli/core/locale.js";
import { revision } from "#cli/view/metrics.js";

export function summary(result, translate) {
  const lines = [];

  if (result.state === "synced") {
    lines.push(translate("synced"));
  }

  lines.push(`[${translate("latest")}] ${revision(result.target)}`);

  for (const node of result.nodes) {
    if (node.skipped) {
      continue;
    }

    const commit = revision(node.commit) ?? translate("unknown");

    lines.push(`[${node.id}] ${commit}`);
  }

  return lines;
}

async function execute(preferences, option = {}) {
  const translate = await locale(preferences);

  const plan = await progress.wait(
    () => update.prepare(option),
    preferences.language,
  );

  const lines = [
    `[${translate("commit")}] ${revision(plan.commit)}`,
    `[${translate("latest")}] ${revision(plan.target)}`,
  ];

  await screen.result(translate("update"), lines);

  git.guard(plan);

  if (option.confirm) {
    await screen.menu(["update"], translate, { title: "update", append: true });

    if ((await screen.choice(["0", "1"])) !== "1") {
      return { state: "cancelled", target: plan.target };
    }
  }

  const display = await progress.open(preferences.language, {
    operation: "update",
  });

  display.resume();

  try {
    const result = await update.run(plan, {
      ...option,
      signal: option.signal ?? input.signal,
      progress: display.update,
    });

    display.close();

    const ready = result.state === "ready";
    const requested = option.check;
    const checking = requested && ready;

    if (checking) {
      const found = result.nodes.every((node) => {
        const matching = node.commit === result.target;
        const complete = node.state === "complete";
        const available = !node.skipped;
        const valid = matching && complete && available;

        return valid;
      });
      const populated = result.nodes.length > 0;
      const latest = populated && found;

      if (latest) {
        result.state = "synced";
      }
    }

    const lines = summary(result, translate);

    let tone = "success";
    let title = translate(result.state);

    const caution = ["partial", "busy"].includes(result.state);

    if (caution) {
      tone = "warning";
      title = translate("update");
    }

    await screen.result(title, lines, { tone });

    return result;
  } catch (failure) {
    display.close();

    if (failure.phase) {
      console.error(`[${translate("update")}] ${failure.phase}`);
    }

    if (failure.target) {
      console.error(`[${translate("latest")}] ${revision(failure.target)}`);
    }

    for (const node of failure.nodes ?? []) {
      console.error(
        `[${node.id}] ${revision(node.commit) ?? translate("unknown")}`,
      );
    }

    for (const entry of failure.recovery ?? []) {
      console.error(`[${entry.node}] ${entry.code}`);
    }

    throw failure;
  } finally {
    display.close();

    if (option.confirm) {
      input.open();
    }
  }
}

export async function open(preferences, option = {}) {
  if (!option.confirm) {
    return await execute(preferences, option);
  }

  const translate = await locale(preferences);

  while (true) {
    const result = await execute(preferences, {
      ...option,
      confirm: false,
      check: true,
    });
    const latest = result.state === "synced";
    const busy = result.state === "busy";
    const refresh = latest || busy;
    const items = [];

    if (refresh) {
      items.push("refresh");
    } else {
      items.push("update");
    }

    input.open();

    await screen.menu(items, translate, { title: "update", append: true });

    const selected = await screen.choice(["0", "1"]);

    if (selected === "0") {
      return result;
    }

    if (!refresh) {
      return await execute(preferences, { ...option, confirm: false });
    }
  }
}

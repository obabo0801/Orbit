import * as profile from "#cli/view/support.js";
import * as cluster from "#cli/core/cluster.js";
import * as detail from "#cli/view/service.js";
import * as input from "#cli/view/input.js";
import { execute } from "#cli/core/service.js";
import * as config from "#cli/core/config.js";
import { locale } from "#cli/core/locale.js";
import * as permission from "#cli/core/permission.js";
import * as remove from "#cli/core/uninstall.js";
import { startup as apply } from "#cli/core/system.js";
import { system } from "#cli/core/path.js";
import { lock } from "#cli/core/lock.js";
import * as screen from "#cli/view/screen.js";
import * as logs from "#cli/view/logs.js";
import * as progress from "#cli/view/progress.js";
import * as deployment from "#cli/view/update.js";

async function collect(manifest, option = {}) {
  const signal = option.signal ?? input.signal;
  const setting = { timeout: 1500, signal };
  const snapshot = await cluster.view(manifest, setting);
  const reports = snapshot.reports;
  const connectivity = reports.filter((report) => report.role === "EXTERNAL");
  const result = { reports, connectivity };

  return result;
}

export async function snapshot(manifest, translate) {
  if (!manifest) {
    screen.banner();

    return;
  }

  const { reports, connectivity } = await collect(manifest);
  const services = detail.summary(reports, translate);

  screen.banner();

  console.log(services.lines.join("\n"));

  const supporting = detail.support(reports, connectivity, translate);

  console.log(supporting.lines.join("\n"));

  const result = { reports, supporting };

  return result;
}

function status(name, preferences) {
  const languages = { auto: "auto", ko: "한국어", en: "English" };
  const language = languages[preferences.language];

  let startup;

  if (preferences.startup) {
    startup = "enable";
  } else {
    startup = "disable";
  }

  const values = { language, startup };

  return values[name];
}

async function report(result, translate, operation) {
  async function content() {
    if (typeof result === "string") {
      await screen.message(result, translate, operation);
    } else if (typeof result?.code !== "number") {
      await screen.failure(result, translate, operation);
    }
  }

  const title = operation ?? "operation";
  const append = ["logs", "install", "uninstall"].includes(operation);
  const option = { title, append, content };

  await screen.menu([], translate, option);

  await screen.choice(["0"]);
}

async function settings(preferences) {
  let translate = await locale(preferences);

  const menus = {
    language: ["auto", "한국어", "English"],
    startup: ["enable", "disable"],
  };

  while (input.active()) {
    const items = ["language", "startup"];

    await screen.menu(items, translate, { title: "settings" });

    const selection = await screen.choice(["0", "1", "2"]);

    if (selection === "0") {
      return;
    }

    let name;

    if (selection === "1") {
      name = "language";
    } else {
      name = "startup";
    }

    let choices;

    if (name === "language") {
      choices = ["0", "1", "2", "3"];
    } else {
      choices = ["0", "1", "2"];
    }

    const key = status(name, preferences);
    const present = translate(key);
    const option = { title: name, value: present, key };

    await screen.menu(menus[name], translate, option);

    const value = await screen.choice(choices);

    if (value === "0") {
      continue;
    }

    if (name === "language") {
      preferences.language = ["auto", "ko", "en"][Number(value) - 1];
    } else {
      const enabled = value === "1";
      const manifest = await config.installation();

      let valid = system();

      if (valid) {
        valid = manifest;
      }

      if (valid) {
        const release = await lock("service");

        try {
          await apply(manifest, enabled);
        } finally {
          await release();
        }
      }

      preferences.startup = enabled;
    }

    await config.save(preferences);

    translate = await locale(preferences);
  }
}

async function removal(translate, preferences) {
  await screen.menu(["normal", "all"], translate, { title: "uninstall" });

  const selection = await screen.choice(["0", "1", "2"]);

  if (selection === "0") {
    return false;
  }

  if (selection === "2") {
    screen.clear();

    await screen.warning(translate("erase"));

    for (const filename of await remove.preview()) {
      console.log(filename);
    }

    await screen.menu(["confirm"], translate, {
      title: "uninstall",
      append: true,
    });

    if ((await screen.choice(["0", "1"])) !== "1") {
      return false;
    }
  }

  screen.clear();

  const all = selection === "2";
  const option = { confirmed: all, language: preferences.language };
  const result = await permission.uninstall(all, option);

  if (!["complete", "skipped"].includes(result)) {
    await report(result, translate, "uninstall");
  }

  return true;
}

export async function dashboard(preferences, option = {}) {
  while (true) {
    let output = process.stdin.isTTY;

    if (output) {
      output = !input.active();
    }

    if (output) {
      return;
    }

    const translate = await locale(preferences);

    async function prepare(signal) {
      const manifest = await config.installation();

      let values;

      if (manifest) {
        values = await collect(manifest, { signal });
      } else {
        values = {};
      }

      const result = { manifest, ...values };

      return result;
    }

    const prepared = await progress.wait(prepare, preferences.language);
    const manifest = prepared.manifest;

    screen.clear();

    if (!manifest) {
      await snapshot(manifest, translate);
    }

    if (!manifest) {
      const layout = { exit: "exit", append: true };

      await screen.menu(["install", "settings"], translate, layout);

      if (!process.stdin.isTTY) {
        return;
      }

      const selection = await screen.choice(["0", "1", "2"]);

      if (selection === "0") {
        return;
      }

      if (selection === "1") {
        screen.clear();

        try {
          const result = await permission.install(
            process.env.ORBIT_PLAN,
            preferences.language,
          );

          if (result?.dashboard) {
            return;
          }

          if (result?.cancelled) {
            continue;
          }

          const completed = ["complete", "skipped"].includes(result);

          if (completed) {
            preferences = await option.refresh();

            continue;
          }

          await screen.menu([], translate, { title: "install", append: true });

          await screen.choice(["0"]);
        } catch (failure) {
          await report(failure, translate, "install");
        }
      }

      if (selection === "2") {
        await settings(preferences);
      }

      continue;
    }

    const commands = [
      "start",
      "stop",
      "restart",
      "logs",
      "update",
      "settings",
      "uninstall",
    ];

    let { reports, connectivity } = prepared;

    async function update(option) {
      ({ reports, connectivity } = await collect(manifest, option));
    }

    function draw(selected) {
      const lines = screen.heading();
      const setting = { selected };
      const summary = detail.summary(reports, translate, setting);

      const targets = summary.targets.map(function item(target) {
        const id = target.id;
        const row = target.row + lines.length;
        const result = { id, row };

        return result;
      });

      lines.push(...summary.lines);

      const support = detail.support(reports, connectivity, translate, setting);
      const boundary = lines.length;

      for (const target of support.targets) {
        const id = target.id;
        const row = target.row + boundary;

        targets.push({ id, row });
      }

      lines.push(...support.lines);

      const option = { selected, exit: "exit" };
      const menu = screen.actions(commands, translate, option);
      const offset = lines.length;

      for (const target of menu.targets) {
        const id = target.id;
        const row = target.row + offset;

        targets.push({ id, row });
      }

      lines.push(...menu.lines);

      const result = { lines, targets };

      return result;
    }

    const selection = await screen.page(draw, { update });

    if (detail.supporting.includes(selection)) {
      await profile.open(manifest, selection, translate);

      continue;
    }

    if (
      reports.some((report) => {
        return report.name === selection;
      })
    ) {
      await detail.detail(manifest, selection, translate);

      continue;
    }

    if (selection === "0") {
      return;
    }

    const command = commands[Number(selection) - 1];

    if (command === "update") {
      try {
        await deployment.open(preferences, { confirm: true });
      } catch (failure) {
        await report(failure, translate, command);
      }
    } else if (command === "settings") {
      await settings(preferences);
    } else if (command === "uninstall") {
      try {
        if (await removal(translate, preferences)) {
          preferences = await option.reset();

          continue;
        }
      } catch (failure) {
        await report(failure, translate, "uninstall");
      }
    } else if (command === "logs") {
      try {
        await logs.open(manifest, translate);
      } catch (failure) {
        await report(failure, translate, command);
      }
    } else {
      const targets = ["targets", "WAS", "WEB", "DB"];

      await screen.menu(targets, translate, { title: command });

      const selected = await screen.choice(["0", "1", "2", "3", "4"]);

      if (selected === "0") {
        continue;
      }

      let target;

      if (selected === "1") {
        target = undefined;
      } else {
        target = targets[Number(selected) - 1];
      }

      const setting = { target };

      screen.clear();

      try {
        await report(
          await execute(command, manifest, setting),
          translate,
          command,
        );
      } catch (failure) {
        await report(failure, translate, command);
      }
    }
  }
}

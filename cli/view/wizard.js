import * as input from "#cli/view/input.js";
import * as screen from "#cli/view/screen.js";
import { locale } from "#cli/core/locale.js";
import { error } from "#cli/core/error.js";

async function roles(translate) {
  const items = ["full", "database", "backend", "frontend"];
  const option = { title: "wizard" };

  await screen.menu(items, translate, option);

  const value = await screen.choice(["0", "1", "2", "3", "4"]);
  const choices = [["db", "was", "caddy"], ["db"], ["was"], ["caddy"]];

  let result;

  if (value === "0") {
    result = null;
  } else {
    result = choices[Number(value) - 1];
  }

  return result;
}

async function save(translate) {
  await screen.menu(["save"], translate, { title: "wizard" });

  const value = await screen.choice(["0", "1"]);

  return value === "1";
}

export async function ask(field, option = {}) {
  const owned = !input.active();

  if (owned) {
    input.open();
  }

  if (!input.active()) {
    throw error("config", { reason: "required" });
  }

  try {
    const language = option.language ?? "auto";
    const translate = await locale({ language });

    if (field.kind === "roles") {
      return await roles(translate);
    }

    if (field.kind === "save") {
      return await save(translate);
    }

    throw error("unsupported");
  } finally {
    if (owned) {
      input.close();
    }
  }
}

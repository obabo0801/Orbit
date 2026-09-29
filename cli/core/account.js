import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import * as platform from "#cli/core/platform.js";
import { error } from "#cli/core/error.js";

export async function create(record, name) {
  if (record.accounts.includes(name)) {
    return;
  }

  const found = await command.run("/usr/bin/id", ["-u", name], { allow: true });

  if (found.code === 0) {
    throw error("collision");
  }

  const group = await platform.host.group(name);

  if (group !== null) {
    throw error("collision");
  }

  record.accounts.push(name);

  await store.write(record);

  await platform.host.create(name);

  record.identities ??= {};

  const user = await command.run("/usr/bin/id", ["-u", name]);
  const identity = await command.run("/usr/bin/id", ["-g", name]);
  const uid = Number(user.output.trim());
  const gid = Number(identity.output.trim());

  record.identities[name] = { uid, gid };

  await store.write(record);
}

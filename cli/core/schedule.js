import * as fs from "node:fs/promises";
import * as platform from "#cli/platform/index.js";
import * as linux from "#cli/platform/linux/schedule.js";
import * as mac from "#cli/platform/mac/schedule.js";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";

const providers = { linux, win32: linux, darwin: mac };
const provider = providers[process.platform];

async function authorized(manifest, filename) {
  const details = await store.exists(filename);

  if (!details) {
    return false;
  }

  const entry = store.entry(manifest, filename);
  const secure = store.secure(details);

  let same = false;

  if (entry) {
    same = (await store.digest(filename)) === entry.hash;
  }

  const valid = secure && same;

  if (!valid) {
    throw new Error("BACKUP_OWNER: Schedule changed outside Orbit.");
  }

  return true;
}

export async function remove(manifest) {
  const filename = path.unit("orbit-backup.service");

  if (!(await authorized(manifest, filename))) {
    return;
  }

  if (!platform.mac) {
    await authorized(manifest, path.unit("orbit-backup.timer"));
  }

  await provider.stop();
}

export async function set(manifest, policy) {
  const files = provider.render(manifest, policy.interval ?? 86400);

  for (const filename of files.keys()) {
    await authorized(manifest, filename);
  }

  await remove(manifest);

  if (platform.mac) {
    const filename = path.journal("backup");
    const details = await store.exists(filename);

    if (!details) {
      const option = { mode: 0o600 };

      await store.file(manifest, filename, "", option);

      const entry = store.entry(manifest, filename);

      entry.type = "log";
      entry.uid = 0;
      entry.gid = 0;

      await store.write(manifest);
    } else if (!store.entry(manifest, filename)) {
      throw new Error("BACKUP_OWNER: Unmanaged backup log.");
    }
  }

  for (const [filename, contents] of files) {
    const entry = store.entry(manifest, filename);

    if (!entry) {
      await store.file(manifest, filename, contents);
    } else {
      await fs.writeFile(filename, contents, { mode: 0o644 });

      entry.hash = await store.digest(filename);

      await store.write(manifest);
    }
  }

  if (policy.enabled) {
    await provider.start();
  }
}

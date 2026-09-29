import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as source from "#cli/core/source.js";
import * as git from "#cli/core/git.js";
import * as command from "#cli/core/process.js";

export const executable = "/Library/PrivilegedHelperTools/com.orbit.update";

export const policy = "/private/etc/sudoers.d/orbit-update";

export const directory = path.child(path.home, "privileged");

export const filename = path.child(directory, "access.json");

export function validate(request, access) {
  const present = request !== null;
  const record = typeof request === "object";
  const object = present && record;

  git.check(object, "REQUEST", "Use an Orbit Update request.");

  const fields = ["id", "target", "checkout", "action"];
  const keys = Object.keys(request);
  const complete = keys.length === fields.length;
  const known = keys.every((key) => fields.includes(key));
  const valid = complete && known;

  git.check(valid, "REQUEST", "Unsupported Update request fields.");

  git.check(git.sha(request.target), "TARGET", "Invalid target commit.");

  git.check(
    /^[a-f0-9-]{36}$/u.test(request.id ?? ""),
    "ID",
    "Invalid Update ID.",
  );

  git.check(
    request.checkout === access.checkout,
    "CHECKOUT",
    "Use the authorized development checkout.",
  );

  git.check(
    ["info", "status", "prepare", "apply", "finish", "cancel"].includes(
      request.action,
    ),
    "ACTION",
    "Unsupported privileged Update action.",
  );
}

async function trusted(filename) {
  const details = await fs.lstat(filename);

  git.check(
    store.secure(details),
    "OWNER",
    "Update requires a root-owned program without shared write access.",
  );
}

export async function authorize(checkout) {
  command.root();

  git.check(process.platform === "darwin", "PLATFORM", "macOS is required.");

  const user = process.env.SUDO_USER;

  git.check(
    /^[a-z_][a-z0-9_-]*$/iu.test(user ?? ""),
    "USER",
    "Run authorization through the existing administrator prompt.",
  );

  const record = await store.read();
  const inspection = await git.inspect(checkout, { installed: path.source });
  const node = path.child(path.source, "tools/node/bin/node");

  await trusted(node);

  git.check(
    !(await store.exists(directory)),
    "AUTHORIZATION",
    "An existing privileged installation requires administrator review.",
  );

  git.check(
    !(await store.exists(executable)),
    "AUTHORIZATION",
    "An existing privileged launcher must not be replaced.",
  );

  git.check(
    !(await store.exists(policy)),
    "AUTHORIZATION",
    "An existing administrator policy must not be replaced.",
  );

  const access = {
    user,
    checkout: inspection.checkout,
    repository: inspection.repository,
  };

  const sudoers = `${user} ALL=(root) NOPASSWD: ${executable} ""\n`;
  const pending = path.child(path.runtime, "update-sudoers");

  await store.file(record, pending, sudoers, { mode: 0o600 });

  try {
    await command.run("/usr/sbin/visudo", ["-c", "-f", pending]);

    await store.directory(record, directory, { mode: 0o700 });

    await source.copy(
      record,
      path.child(path.checkout, "cli"),
      path.child(directory, "cli"),
    );

    await store.file(record, filename, JSON.stringify(access) + "\n", {
      mode: 0o600,
    });

    const entry = path.child(directory, "cli/privileged.js");

    const launcher = [
      "#!/bin/sh",
      'if [ "$#" -ne 0 ]; then exit 1; fi',
      `exec /usr/bin/env -i HOME=/var/root PATH=/usr/bin:/bin SUDO_USER=${user} ORBIT_SYSTEM=1 "${node}" "${entry}"`,
      "",
    ].join("\n");

    const parent = path.parent(executable);

    if (!(await store.exists(parent))) {
      await store.directory(record, parent);
    }

    await store.file(record, executable, launcher, { mode: 0o755 });

    await store.file(record, policy, sudoers, { mode: 0o440 });
  } finally {
    const primary = await import("#cli/core/primary.js");

    await primary.remove(record, pending);
  }

  return {
    executable,
    checkout: access.checkout,
    repository: access.repository,
  };
}

export async function run(request) {
  command.root();

  await trusted(filename);

  const access = JSON.parse(await fs.readFile(filename, "utf8"));

  git.check(
    process.env.SUDO_USER === access.user,
    "USER",
    "The Update administrator is not authorized.",
  );

  validate(request, access);

  const inspection = await git.inspect(access.checkout, {
    installed: path.source,
    target: request.target,
  });

  git.check(
    inspection.repository === access.repository,
    "ORIGIN",
    "The authorized GitHub repository has changed.",
  );

  const release = await import("#cli/core/release.js");

  return await release.run(request);
}

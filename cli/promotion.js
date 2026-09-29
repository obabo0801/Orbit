import * as fs from "node:fs/promises";
import * as store from "#cli/core/manifest.js";
import * as command from "#cli/core/process.js";
import * as transition from "#cli/core/transition.js";

process.env.ORBIT_SYSTEM = "1";

const [action, filename, confirmation] = process.argv.slice(2);

try {
  command.root();

  const actions = [
    "inspect",
    "prepare",
    "activate",
    "stopped",
    "redirect",
    "slots",
    "credentials",
    "hold",
    "barrier",
    "fence",
    "fenced",
    "seal",
    "promote",
    "verify",
    "apply",
    "resume",
    "abort",
    "join",
    "probe",
    "attach",
    "status",
    "quiesce",
    "quarantine",
    "recover",
    "ready",
    "preflight",
  ];

  if (!actions.includes(action)) {
    throw new Error("PROMOTION_ACTION: Invalid transition operation.");
  }

  let option;

  if (filename) {
    const details = await fs.lstat(filename);
    const owned = store.secure(details);
    const restricted = !(details.mode & 0o077);
    const valid = owned && restricted;

    if (!valid) {
      throw new Error("PROMOTION_OWNER: Unmanaged operating file.");
    }

    option = JSON.parse(await fs.readFile(filename, "utf8"));
  }

  const promoting = action === "promote";
  const missing = confirmation !== "--confirmed";
  const refused = promoting && missing;

  if (refused) {
    throw new Error("PROMOTION_CONFIRM: Explicit approval is required.");
  }

  const manifest = await store.read();
  const result = await transition[action](manifest, option);

  process.stdout.write(JSON.stringify(result ?? { state: "complete" }) + "\n");
} catch (failure) {
  const code = String(failure.message).split(":")[0];
  const recognized = /^PROMOTION_[A-Z_]+$/u.test(code);

  let message;

  if (recognized) {
    message = failure.message;
  } else {
    message = "PROMOTION_FAILED";
  }

  process.stderr.write(message + "\n");

  process.exitCode = 1;
}

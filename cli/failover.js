import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import * as authority from "#cli/core/authority.js";
import * as failover from "#cli/core/failover.js";

process.env.ORBIT_SYSTEM = "1";

try {
  command.root();

  const [action, filename, confirmation] = process.argv.slice(2);

  if (action === "approve") {
    if (confirmation !== "--confirmed") {
      throw new Error("FAILOVER_CONFIRM: Explicit approval is required.");
    }

    const details = await fs.lstat(filename);
    const secure = store.secure(details);
    const restricted = (details.mode & 0o077) === 0;
    const valid = secure && restricted;

    if (!valid) {
      throw new Error("FAILOVER_OWNER: Unmanaged operating file.");
    }

    const option = JSON.parse(await fs.readFile(filename, "utf8"));

    const result = await authority.approve(await store.read(), {
      ...option,
      confirmed: true,
    });

    console.log(JSON.stringify(result));
  } else if (["run", "rejoin", "acknowledge"].includes(action)) {
    const approval = await authority.read();
    const filename = await authority.adapter(approval);
    const control = await import(pathToFileURL(filename));
    const peers = await control.connect(approval);

    let result;

    if (action === "run") {
      result = await failover.run(peers.source, peers.target, {
        health: peers.health,
        peers: peers.peers,
      });
    } else if (action === "rejoin") {
      result = await failover.rejoin(peers.source, peers.target);
    } else {
      result = await failover.acknowledge(peers.source, peers.target, {
        confirmed: confirmation === "--confirmed",
      });
    }

    console.log(JSON.stringify(result));
  } else if (action === "status") {
    console.log(JSON.stringify(await failover.state()));
  } else {
    throw new Error("FAILOVER_ACTION: Invalid failover operation.");
  }
} catch (failure) {
  const code = String(failure.message).split(":")[0];
  const recognized = /^(?:FAILOVER|PROMOTION)_[A-Z_]+$/u.test(code);

  let message;

  if (recognized) {
    message = failure.message;
  } else {
    message = "FAILOVER_UNAVAILABLE";
  }

  console.error(message);

  process.exitCode = 1;
}

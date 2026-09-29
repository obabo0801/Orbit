import * as record from "#cli/core/record.js";
import * as store from "#cli/core/manifest.js";
import * as cluster from "#cli/core/cluster.js";

const controller = new globalThis.AbortController();

let server;
let replication;

function cancel() {
  controller.abort();
}

process.once("SIGINT", cancel);

process.once("SIGTERM", cancel);

try {
  const manifest = await store.read();

  if (!manifest?.installed) {
    throw new Error("MONITOR: Installation unavailable.");
  }

  const option = { signal: controller.signal };

  try {
    server = await cluster.open(manifest, option);
  } catch (failure) {
    console.error(failure.message);
  }

  replication = cluster.follow(option).catch(() => {
    if (!controller.signal.aborted) {
      console.error("CLUSTER_HISTORY: Remote history preservation failed.");
    }
  });

  await record.run(manifest, option);
} catch (failure) {
  if (!controller.signal.aborted) {
    console.error(failure.message);

    process.exitCode = 1;
  }
} finally {
  controller.abort();

  await replication;

  server?.close();

  server?.closeAllConnections();

  process.removeListener("SIGINT", cancel);

  process.removeListener("SIGTERM", cancel);
}

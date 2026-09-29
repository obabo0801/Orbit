import * as update from "#cli/platform/mac/update.js";
import { Buffer } from "node:buffer";

try {
  if (process.platform !== "darwin") {
    throw new Error("UPDATE_PLATFORM: macOS is required.");
  }

  if (process.argv.length !== 2) {
    throw new Error("UPDATE_REQUEST: Command arguments are not supported.");
  }

  const chunks = [];

  let length = 0;

  for await (const chunk of process.stdin) {
    length += chunk.length;

    if (length > 8192) {
      throw new Error("UPDATE_REQUEST: Request size exceeded.");
    }

    chunks.push(chunk);
  }

  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await update.run(request);

  console.log("ORBIT_UPDATE=" + JSON.stringify({ ok: true, result }));
} catch (failure) {
  const identified = String(failure.message).startsWith("UPDATE_");

  let message = "UPDATE_FAILED: Privileged Update failed.";

  if (identified) {
    message = failure.message;
  }

  const code = failure.code ?? "UPDATE_FAILED";

  const report = { ok: false, code, message };

  if (code === "UPDATE_FETCH") {
    report.exit = failure.exit;
    report.diagnostic = failure.diagnostic;
    report.elapsed = failure.elapsed;
    report.timeout = failure.timeout;
  }

  console.log("ORBIT_UPDATE=" + JSON.stringify(report));

  process.exitCode = 1;
}

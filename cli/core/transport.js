import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import * as windows from "#cli/platform/windows/update.js";
import * as mac from "#cli/platform/mac/update.js";
import { layout } from "#cli/platform/index.js";
import * as git from "#cli/core/git.js";
import * as release from "#cli/core/release.js";

function quote(value) {
  const text = value.replaceAll("'", "'\\''");
  const quoted = "'" + text + "'";

  return quoted;
}

export function validate(node, local) {
  if (local) {
    return;
  }

  const access = node.update;

  git.check(
    access,
    "ACCESS",
    `Private SSH access is not configured for ${node.id}.`,
  );

  git.check(
    ["linux", "windows", "mac"].includes(access.platform),
    "PLATFORM",
    "Invalid Update transport platform.",
  );

  git.check(
    /^[a-z0-9_.-]+@[a-z0-9.-]+$/iu.test(access.ssh ?? ""),
    "SSH",
    "Configure an SSH user and private hostname without credentials.",
  );

  const address = access.ssh.split("@").at(-1);

  git.check(
    address === node.address,
    "SSH",
    "SSH must use the registered private Node address.",
  );

  git.check(
    typeof access.checkout === "string",
    "CHECKOUT",
    "Configure the Node's development checkout path.",
  );

  if (access.platform === "windows") {
    git.check(
      /^[a-z0-9_. -]+$/iu.test(access.distribution ?? ""),
      "WSL",
      "Configure the Orbit WSL distribution.",
    );
  }
}

async function modules(root, action, checkout = path.checkout) {
  const mapped = new Map();
  const names = [
    "core/git.js",
    "core/source.js",
    "core/lock.js",
    "core/service.js",
    "core/release.js",
  ];

  if (action === "rolling") {
    names.unshift("platform/windows/update.js");

    names.push("core/transport.js", "core/update.js");
  }

  for (const name of names) {
    const filename = path.child(checkout, "cli/" + name);
    const contents = await fs.readFile(filename, "utf8");

    const text = contents.replace(
      /(["'])#cli\/([^"']+)\1/gu,
      (match, delimiter, name) => {
        const file = new URL("file:///");

        file.pathname = root + "/cli/" + name;

        const address = mapped.get(name) ?? file.href;
        const reference = delimiter + address + delimiter;

        return reference;
      },
    );

    const encoded = Buffer.from(text).toString("base64");

    mapped.set(name, "data:text/javascript;base64," + encoded);
  }

  let name = "release";

  if (action === "rolling") {
    name = "update";
  }

  return mapped.get("core/" + name + ".js");
}

async function worker(node, request, option = {}) {
  const platform = node.update.platform;
  const native = "linux";
  const root = layout(native).source;
  const address = await modules(root, request.action, option.checkout);

  const parameters = JSON.stringify(request).replace(
    /[^\u0020-\u007e]/g,
    (value) => {
      const encoded = value.charCodeAt(0).toString(16).padStart(4, "0");

      return "\\u" + encoded;
    },
  );

  let invocation = `  const result = await core.run(${parameters}, { signal: controller.signal });`;

  if (request.action === "rolling") {
    invocation = [
      `  const result = await core.dispatch(${parameters}, {`,
      "    signal: controller.signal,",
      '    progress: (value) => console.log("ORBIT_PROGRESS=" + JSON.stringify(value)),',
      "  });",
    ].join("\n");
  }

  const lines = [
    'process.env.ORBIT_SYSTEM = "1";',
    "const controller = new AbortController();",
    'for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {',
    "  process.once(signal, () => controller.abort());",
    "}",
    `if (process.platform !== ${JSON.stringify(native)}) { throw new Error("UPDATE_PLATFORM: Unexpected Node platform."); }`,
    "try {",
    `  const core = await import(${JSON.stringify(address)});`,
    invocation,
    '  console.log("ORBIT_UPDATE=" + JSON.stringify({ ok: true, result }));',
    "} catch (failure) {",
    '  let code = failure.code ?? "UPDATE_FAILED";',
    '  if (failure.name === "AbortError") { code = "UPDATE_ABORT"; }',
    "  let message;",
    '  if (String(failure.message).startsWith("UPDATE_")) {',
    "    message = failure.message;",
    "  } else {",
    '    message = "UPDATE_FAILED: Node preparation or application failed.";',
    "  }",
    "  const report = { ok: false, code, message };",
    "  report.phase = failure.phase;",
    "  report.target = failure.target;",
    "  report.nodes = failure.nodes;",
    "  report.recovery = failure.recovery;",
    '  if (code === "UPDATE_FETCH") {',
    "    report.exit = failure.exit;",
    "    report.diagnostic = failure.diagnostic;",
    "    report.elapsed = failure.elapsed;",
    "    report.timeout = failure.timeout;",
    "  }",
    '  console.log("ORBIT_UPDATE=" + JSON.stringify(report));',
    "  process.exitCode = 1;",
    "}",
    "",
  ];

  const candidates = [
    root + "/tools/node/bin/node",
    "/opt/node24/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];

  const entries = candidates.map(quote).join(" ");

  const script = [
    `for program in ${entries}; do`,
    '  if [ -x "$program" ]; then',
    '    exec /usr/bin/sudo -n -- /usr/bin/env ORBIT_SYSTEM=1 "$program" --input-type=module',
    "  fi",
    "done",
    "exit 1",
  ].join("\n");

  let shell = "/bin/sh -c " + quote(script);

  let input = lines.join("\n");

  if (platform === "windows") {
    input = windows.encode(input);

    shell = windows.remote(script, node.update.distribution, input);
  }

  return { shell, input };
}

function failure(node, reason, result = {}, cause) {
  const error = new Error(
    `UPDATE_${reason}: Remote Update transport failed for ${node.id}.`,
    { cause },
  );

  const diagnostic = String(result.diagnostic ?? "");

  const messages =
    diagnostic.match(
      new RegExp(
        [
          "Permission denied",
          "Connection refused",
          "Connection timed out",
          "Could not resolve hostname",
          "Host key verification failed",
          "UPDATE_INPUT: [A-Za-z .]+",
        ].join("|"),
        "gu",
      ),
    ) ?? [];

  error.code = "UPDATE_" + reason;
  error.node = node.id;
  error.exit = result.code ?? null;
  error.diagnostic = [...new Set(messages)].join("; ").slice(0, 512);
  error.bytes = Buffer.byteLength(diagnostic);
  error.elapsed = result.elapsed;
  error.aborted = reason === "ABORT";
  error.timeout = reason === "TIMEOUT";

  return error;
}

export async function prepare(node, request, option = {}) {
  const platform = node.update.platform;

  if (platform === "linux") {
    return await worker(node, request, option);
  } else if (platform === "windows") {
    return await worker(node, request, option);
  } else if (platform === "mac") {
    return {
      shell: "/usr/bin/sudo -n -- " + quote(mac.executable),
      input: JSON.stringify(request),
    };
  }

  throw new Error("UPDATE_PLATFORM: Unsupported Update transport platform.");
}

export async function run(node, settings, request, option = {}) {
  const local = node.id === settings.local;

  validate(node, local);

  if (local) {
    return await release.run(request, option);
  }

  const prepared = await prepare(node, request, option);

  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    node.update.ssh,
    prepared.shell,
  ];

  const observing = ["status", "info"].includes(request.action);

  let duration;

  if (observing) {
    duration = 30000;
  } else {
    duration = 1500000;
  }

  const timeout = option.timeout ?? duration;
  const started = performance.now();

  let result;

  try {
    result = await command.run("ssh", args, {
      allow: true,
      input: prepared.input,
      timeout,
      signal: option.signal,
      line: async (line) => {
        if (request.action !== "rolling") {
          return;
        }

        if (line.startsWith("ORBIT_PROGRESS=")) {
          const value = JSON.parse(line.slice("ORBIT_PROGRESS=".length));

          await option.progress?.(value);
        }
      },
    });
  } catch (cause) {
    let reason = "TRANSPORT";

    if (cause.name === "AbortError") {
      reason = "ABORT";
    } else if (cause.name === "TimeoutError") {
      reason = "TIMEOUT";
    }

    throw failure(
      node,
      reason,
      {
        code: cause.exitCode,
        diagnostic: cause.diagnostic,
        elapsed: performance.now() - started,
      },
      cause,
    );
  }

  result.elapsed = performance.now() - started;

  if (option.signal?.aborted) {
    throw failure(node, "ABORT", result);
  }

  if (result.code === null) {
    let reason = "TRANSPORT";

    if (result.elapsed >= timeout) {
      reason = "TIMEOUT";
    }

    throw failure(node, reason, result);
  }

  const line = result.output
    .split(/\r?\n/u)
    .findLast((line) => line.startsWith("ORBIT_UPDATE="));

  if (!line) {
    let reason = "RESPONSE";

    const rejected = new RegExp(
      [
        "Permission denied",
        "Connection refused",
        "Connection timed out",
        "Could not resolve hostname",
        "Host key verification failed",
      ].join("|"),
      "u",
    ).test(result.diagnostic);

    const disconnected = result.code === 255;
    const incomplete = result.diagnostic.includes("UPDATE_INPUT:");

    if (incomplete) {
      reason = "INPUT";
    } else if (rejected && disconnected) {
      reason = "SSH";
    } else if (result.code !== 0) {
      reason = "TRANSPORT";
    }

    throw failure(node, reason, result);
  }

  let value;

  try {
    value = JSON.parse(line.slice("ORBIT_UPDATE=".length));
  } catch (cause) {
    throw failure(node, "RESPONSE", result, cause);
  }

  let valid = value !== null;

  if (valid) {
    valid = typeof value.ok === "boolean";
  }

  if (!valid) {
    throw failure(node, "RESPONSE", result);
  }

  if (!value.ok) {
    const error = failure(node, "TRANSPORT", result);

    error.message = value.message;
    error.code = value.code;
    error.phase = value.phase;
    error.target = value.target;
    error.nodes = value.nodes;
    error.recovery = value.recovery;

    if (value.code === "UPDATE_FETCH") {
      error.exit = value.exit ?? result.code;
      error.diagnostic = String(value.diagnostic ?? "").slice(0, 512);
      error.duration = value.elapsed;
      error.timeout = value.timeout === true;
    }

    throw error;
  }

  if (result.code !== 0) {
    throw failure(node, "TRANSPORT", result);
  }

  return value.result;
}

export async function coordinate(node, settings, target, option = {}) {
  const supported = ["linux", "windows"].includes(node.update?.platform);

  git.check(supported, "PLATFORM", "Use a Linux or WSL Update coordinator.");

  const request = {
    id: randomUUID(),
    target,
    checkout: node.update.checkout,
    action: "rolling",
  };

  return await run(node, settings, request, option);
}

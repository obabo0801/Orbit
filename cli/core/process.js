import * as platform from "#cli/platform/index.js";
import { spawn } from "node:child_process";
import * as path from "#cli/core/path.js";
import * as readline from "node:readline";

function environment(program, additions = {}) {
  const env = { ...process.env };
  const search = path.search(program, env);

  env[search.key] = search.value;

  for (const [name, value] of Object.entries(additions)) {
    let searching = process.platform === "win32";

    if (searching) {
      searching = name.toUpperCase() === "PATH";
    }

    let key;

    if (searching) {
      key = search.key;
    } else {
      key = name;
    }

    env[key] = value;
  }

  return env;
}

export function terminal(program, args = []) {
  const result = new Promise(function execute(resolve, reject) {
    const env = environment(program);
    const settings = { env, stdio: "inherit" };
    const child = spawn(program, args, settings);

    child.on("error", reject);

    child.on("close", function finish(code) {
      resolve(code ?? 1);
    });
  });

  return result;
}

export function run(program, args = [], options = {}) {
  const result = new Promise(function execute(resolve, reject) {
    const cwd = options.cwd;
    const timeout = options.timeout ?? 30000;
    const stdio = ["pipe", "pipe", "pipe"];
    const signal = "SIGKILL";
    const env = environment(program, options.env);
    const encoding = options.encoding ?? "utf8";
    const abort = options.signal;

    const settings = {
      cwd,
      env,
      stdio,
      timeout,
      killSignal: signal,
      signal: abort,
    };

    const child = spawn(program, args, settings);

    let output = "";
    let diagnostic = "";
    let reader;
    let failure;
    let pending = Promise.resolve();

    if (options.line) {
      reader = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });

      reader.on("line", (line) => {
        pending = pending
          .then(() => options.line(line))
          .catch((cause) => {
            failure = cause;

            child.kill();
          });
      });
    }

    child.stdout.on("data", function read(buffer) {
      output = (output + buffer.toString(encoding)).slice(-2097152);
    });

    child.stderr.on("data", function read(buffer) {
      diagnostic = (diagnostic + buffer.toString(encoding)).slice(-2097152);
    });

    child.on("error", reject);

    child.on("close", async function finish(code) {
      reader?.close();

      await pending;

      if (failure) {
        reject(failure);

        return;
      }

      let valid = code !== 0;

      if (valid) {
        valid = !options.allow;
      }

      if (valid) {
        const failure = new Error(`SYSTEM_COMMAND: ${program} failed.`);

        failure.code = "system";
        failure.diagnostic = diagnostic;

        reject(failure);
      } else {
        resolve({ code, output, diagnostic });
      }
    });

    child.stdin.on("error", function discard() {});

    child.stdin.end(options.input ?? "");
  });

  return result;
}

export function root() {
  let valid = !platform.native;

  if (!valid) {
    valid = process.getuid?.() !== 0;
  }

  if (valid) {
    const failure = new Error(
      "SYSTEM_ROOT: Administrator permission required.",
    );

    failure.code = "permission";

    throw failure;
  }
}

export function follow(program, args, option = {}) {
  if (option.source) {
    return stream(option.source, option);
  }

  const output = new Promise(function execute(resolve, reject) {
    const env = environment(program);
    const signal = option.signal;
    const stdio = ["ignore", "pipe", "pipe"];
    const settings = { env, signal, stdio };
    const child = spawn(program, args, settings);

    let failure;
    let reader;

    if (option.format) {
      const input = child.stdout;
      const setting = { input, crlfDelay: Infinity };

      reader = readline.createInterface(setting);

      reader.on("line", function line(text) {
        if (failure) {
          return;
        }

        try {
          const formatted = option.format(text);

          process.stdout.write(formatted + "\n");
        } catch (fault) {
          failure = fault;

          child.kill();
        }
      });
    } else {
      child.stdout.pipe(process.stdout, { end: false });
    }

    child.stderr.pipe(process.stderr, { end: false });

    child.on("error", function failed(error) {
      if (error.name !== "AbortError") {
        failure = error;
      }
    });

    child.on("close", function finish(code) {
      reader?.close();

      child.stdout.unpipe(process.stdout);

      child.stderr.unpipe(process.stderr);

      child.stdout.destroy();

      child.stderr.destroy();

      if (failure) {
        reject(failure);
      } else {
        let valid = signal?.aborted;

        if (!valid) {
          valid = code === 0;
        }

        if (valid) {
          resolve();
        } else {
          const failure = new Error("SYSTEM_COMMAND: Log follow failed.");

          failure.code = "system";

          reject(failure);
        }
      }
    });
  });

  return output;
}

export async function stream(source, option = {}) {
  try {
    for await (const text of source) {
      if (option.signal?.aborted) {
        break;
      }

      process.stdout.write(text);
    }
  } catch (failure) {
    let valid = !option.signal?.aborted;

    if (!valid) {
      valid = failure.name !== "AbortError";
    }

    if (valid) {
      throw failure;
    }
  }
}

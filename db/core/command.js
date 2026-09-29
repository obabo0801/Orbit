import { spawn } from "node:child_process";
import process from "node:process";

export async function run(program, args, option = {}) {
  const env = { ...process.env, ...option.env };
  const timeout = option.timeout ?? 300000;
  const signal = option.signal;
  const stdio = ["ignore", "pipe", "pipe"];
  const settings = { env, timeout, signal, stdio };

  const result = await new Promise((resolve, reject) => {
    const child = spawn(program, args, settings);

    let output = "";

    child.stdout.on("data", (buffer) => {
      output = (output + buffer.toString("utf8")).slice(-1048576);
    });

    child.stderr.resume();

    child.on("error", (cause) => {
      reject(new Error("BACKUP_TOOL: Tool execution failed.", { cause }));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("BACKUP_TOOL: Tool execution failed."));
      } else {
        resolve(output);
      }
    });
  });

  return result;
}

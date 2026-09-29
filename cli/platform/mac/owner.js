import * as command from "#cli/core/process.js";

export async function local(pid) {
  const args = ["-p", String(pid), "-o", "lstart=,command="];
  const settings = { allow: true, env: { LC_ALL: "C" } };
  const report = await command.run("/bin/ps", args, settings);

  if (report.code === 1) {
    const result = { alive: false };

    return result;
  }

  if (report.code !== 0) {
    return null;
  }

  const text = report.output.trim();
  const match = text.match(/^(.{24})\s+(.+)$/);

  if (!match) {
    const value = { alive: true };

    return value;
  }

  const identity = match[1];
  const invocation = match[2];
  const answer = { alive: true, identity, command: invocation };

  return answer;
}

import process from "node:process";
import { status } from "#was/database/connection.js";

export async function health(kind, closing) {
  if (kind === "live") {
    let code;

    if (closing) {
      code = 503;
    } else {
      code = 200;
    }

    const live = !closing;
    const pid = process.pid;
    const uptime = process.uptime();
    const body = { live, pid, uptime };
    const reply = { code, data: body };

    return reply;
  }

  const connection = await status();

  let ready = !closing;

  if (ready) {
    ready = ["ready", "unconfigured"].includes(connection.state);
  }

  let code;

  if (ready) {
    code = 200;
  } else {
    code = 503;
  }

  const database = connection.state;
  const latency = connection.latency ?? null;
  const body = { ready, database, latency };
  const reply = { code, data: body };

  return reply;
}

import * as fs from "node:fs/promises";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import * as health from "#cli/core/health.js";
import * as network from "#cli/network/health.js";
import * as tools from "#cli/platform/mac/tools.js";

async function tailscale(option) {
  let executable;

  if (process.platform === "win32") {
    executable = "tailscale.exe";
  } else {
    executable = "tailscale";
  }

  const candidates = path.tools(executable);

  if (process.platform === "linux") {
    const kernel = await fs.readFile(path.kernel, "utf8");

    if (/microsoft/iu.test(kernel)) {
      candidates.unshift(
        ...path.tools("tailscale.exe"),
        "/mnt/c/Program Files/Tailscale/tailscale.exe",
      );
    }
  }

  if (process.platform === "darwin") {
    candidates.push(...(await tools.tailscale()));
  }

  for (const program of candidates) {
    try {
      await fs.access(program, fs.constants.X_OK);
    } catch {
      continue;
    }

    try {
      const args = ["status", "--json"];
      const setting = { signal: option.signal, timeout: 5000, allow: true };

      if (process.platform === "darwin") {
        setting.env = { TAILSCALE_BE_CLI: "1" };
      }

      const execution = await command.run(program, args, setting);

      if (execution.code !== 0) {
        const result = { daemon: "unknown" };

        return result;
      }

      const snapshot = JSON.parse(execution.output);

      const states = {
        Running: "ready",
        Starting: "activating",
        Stopped: "inactive",
        NeedsLogin: "unconfigured",
      };

      const daemon = states[snapshot.BackendState] ?? "unknown";
      const hostname = snapshot.Self?.DNSName?.replace(/\.$/u, "");
      const addresses = snapshot.Self?.TailscaleIPs;

      let address;

      if (Array.isArray(addresses)) {
        address = addresses.join(", ");
      } else {
        address = undefined;
      }

      const answer = { daemon, hostname, address };

      return answer;
    } catch (failure) {
      if (option.signal?.aborted) {
        throw failure;
      }

      const response = { daemon: "unknown" };

      return response;
    }
  }

  const report = {};

  return report;
}

export async function external(option = {}) {
  const observations = await Promise.all([
    network.health(option),
    tailscale(option),
  ]);

  const [services, daemon] = observations;

  const tail = services.find((service) => {
    return service.name === "Tailscale";
  });

  if (tail) {
    tail.funnels = {
      primary: services.find((service) => service.name === "Ingress 1"),
      secondary: services.find((service) => service.name === "Ingress 2"),
    };
    tail.funnel = tail.funnels.primary?.state;
    tail.public = tail.address;

    if (tail.address) {
      tail.hostname = new URL(tail.address).hostname;
    } else {
      tail.hostname = undefined;
    }

    if (daemon.address) {
      tail.address = daemon.address;
    }

    if (daemon.hostname) {
      tail.hostname = daemon.hostname;
    }

    tail.daemon = daemon.daemon;

    tail.state = daemon.daemon ?? "unknown";
  }

  return services;
}

export async function collect(manifest, option = {}) {
  const observations = await Promise.all([
    health.health(manifest, option),
    external(option),
  ]);

  const [local, services] = observations;

  const caddy = local.find((report) => {
    return report.role === "CADDY";
  });

  let report;

  if (caddy) {
    report = { ...caddy, name: "Caddy" };
  } else {
    report = { name: "Caddy", role: "CADDY", state: "unknown" };
  }

  const web = local.find((report) => {
    return report.role === "WEB";
  });

  let live = caddy;

  if (live) {
    live = web?.live;
  }

  if (live) {
    report.latency = web.latency;
  }

  const value = [report, ...services];

  return value;
}

import { performance } from "node:perf_hooks";
import * as https from "node:https";
import { Resolver } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import * as config from "#cli/network/config.js";

async function lookup(hostname, options, callback) {
  try {
    const settings = { timeout: 2000, tries: 1 };
    const resolver = new Resolver(settings);
    const servers = ["1.1.1.1", "8.8.8.8"];

    resolver.setServers(servers);

    const addresses = await resolver.resolve4(hostname);

    if (options.all) {
      const entries = addresses.map(function entry(address) {
        const result = { address, family: 4 };

        return result;
      });

      callback(null, entries);
    } else {
      callback(null, addresses[0], 4);
    }
  } catch (failure) {
    callback(failure);
  }
}

export async function probe(origin, options = {}) {
  const bytes = randomBytes(16);
  const nonce = bytes.toString("hex");
  const address = new URL("/health/ingress", origin);

  address.searchParams.set("nonce", nonce);

  const timeout = AbortSignal.timeout(6000);

  let signal;

  if (options.signal) {
    signal = AbortSignal.any([timeout, options.signal]);
  } else {
    signal = timeout;
  }

  const settings = { lookup, family: 4, ...options, signal };

  const result = new Promise(function check(resolve) {
    const request = https.get(address, settings, response);

    function response(reply) {
      let text = "";

      reply.on("data", function read(buffer) {
        text += buffer.toString();

        if (text.length > 4096) {
          request.destroy();
        }
      });

      reply.on("error", function failed() {
        resolve("unavailable");
      });

      reply.on("end", function finish() {
        try {
          const body = JSON.parse(text);

          let marker = body.project === "Orbit";

          if (marker) {
            marker = body.role === "ingress";
          }

          const fresh = reply.headers["x-orbit-probe"] === nonce;
          const status = reply.statusCode === 200;

          let state;

          if (marker && fresh && status) {
            state = "ready";
          } else {
            state = "unavailable";
          }

          resolve(state);
        } catch {
          resolve("unavailable");
        }
      });
    }

    request.on("error", function failed() {
      resolve("unavailable");
    });
  });

  return result;
}

export async function measure(origin, option = {}) {
  const started = performance.now();
  const state = await probe(origin, option);
  const latency = performance.now() - started;
  const checked = Date.now();
  const result = { state, latency, checked };

  return result;
}

export async function external(settings, inspect = measure) {
  const services = [
    { name: "Vercel", origin: settings?.entry },
    {
      name: "Tailscale",
      address: settings?.funnel,
      origins: settings?.origins,
    },
    {
      name: "Ingress 1",
      origin: settings?.origins?.primary ?? settings?.funnel,
    },
    { name: "Ingress 2", origin: settings?.origins?.secondary },
    { name: "TTS" },
    { name: "STT" },
    { name: "GA4" },
  ];

  const requests = services.map(async function report(service) {
    const name = service.name;

    let state = "";
    let latency;
    let checked;

    if (service.origin) {
      try {
        const observation = await inspect(service.origin);

        if (typeof observation === "string") {
          state = observation;
        } else {
          state = observation.state;
        }

        if (typeof observation === "object") {
          latency = observation.latency;
        } else {
          latency = undefined;
        }

        if (typeof observation === "object") {
          checked = observation.checked;
        } else {
          checked = undefined;
        }
      } catch {
        state = "unavailable";
      }
    }

    const address = service.address ?? service.origin;
    const role = "EXTERNAL";
    const report = { name, role, state, address, latency, checked };

    if (service.origins) {
      report.origins = service.origins;
    }

    return report;
  });

  return Promise.all(requests);
}

export async function health(option = {}) {
  try {
    const settings = await config.load();
    const inspect = (origin) => measure(origin, option);

    return await external(settings, inspect);
  } catch {
    const services = await external(null);

    for (const service of services) {
      if (
        ["Vercel", "Tailscale", "Ingress 1", "Ingress 2"].includes(service.name)
      ) {
        service.state = "unknown";
      }
    }

    return services;
  }
}

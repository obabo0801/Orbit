import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "#cli/core/path.js";
import { error } from "#cli/core/error.js";
import * as store from "#cli/core/manifest.js";
import * as primary from "#cli/core/primary.js";
import * as cluster from "#cli/core/cluster.js";
import { lock } from "#cli/core/lock.js";

function object(value) {
  if (value === null) {
    return false;
  }

  if (typeof value !== "object") {
    return false;
  }

  const valid = !Array.isArray(value);

  return valid;
}

function port(value) {
  if (!Number.isInteger(value)) {
    return false;
  }

  if (value <= 0) {
    return false;
  }

  return value <= 65535;
}

function address(value) {
  if (typeof value !== "string") {
    throw error("network");
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw error("network");
  }

  const protocol = ["http:", "https:"].includes(url.protocol);

  let credentials = url.username;

  if (!credentials) {
    credentials = url.password;
  }

  let suffix = url.pathname !== "/";

  if (!suffix) {
    suffix = url.search;
  }

  if (!suffix) {
    suffix = url.hash;
  }

  let invalid = !protocol;

  if (!invalid) {
    invalid = credentials;
  }

  if (!invalid) {
    invalid = suffix;
  }

  if (invalid) {
    throw error("network");
  }

  return url;
}

function origin(value, funnel) {
  let empty = value === null;

  if (!empty) {
    empty = value === undefined;
  }

  if (!empty) {
    empty = value === "";
  }

  if (empty) {
    return null;
  }

  const url = address(value);

  if (url.protocol !== "https:") {
    throw error("network");
  }

  if (funnel) {
    const hostname = /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(url.hostname);
    const allowed = ["", "443", "8443", "10000"].includes(url.port);

    let invalid = !hostname;

    if (!invalid) {
      invalid = !allowed;
    }

    if (invalid) {
      throw error("network");
    }
  }

  return url.origin;
}

export function internal(hostname) {
  let response = hostname === "localhost";

  if (!response) {
    response = hostname === "[::1]";
  }

  if (response) {
    return true;
  }

  if (net.isIP(hostname) !== 4) {
    return false;
  }

  const [first, second] = hostname.split(".").map(Number);

  let local = first === 127;

  if (!local) {
    local = first === 10;
  }

  let lan = first === 172;

  if (lan) {
    lan = second >= 16;
  }

  if (lan) {
    lan = second <= 31;
  }

  let home = first === 192;

  if (home) {
    home = second === 168;
  }

  let tailscale = first === 100;

  if (tailscale) {
    tailscale = second >= 64;
  }

  if (tailscale) {
    tailscale = second <= 127;
  }

  const result = local || lan || home || tailscale;

  return result;
}

function upstreams(values) {
  let valid = !Array.isArray(values);

  if (!valid) {
    valid = values.length === 0;
  }

  if (valid) {
    throw error("network");
  }

  const entries = values.map(function parse(value) {
    const url = address(value);

    if (!internal(url.hostname)) {
      throw error("network");
    }

    return url.origin;
  });

  const protocols = new Set(
    entries.map(function protocol(value) {
      return new URL(value).protocol;
    }),
  );

  const unique = new Set(entries).size === entries.length;

  let report = !unique;

  if (!report) {
    report = protocols.size !== 1;
  }

  if (report) {
    throw error("network");
  }

  return entries;
}

export function parse(network) {
  let sections = object(network);

  if (sections) {
    sections = object(network.web);
  }

  if (sections) {
    sections = object(network.was);
  }

  if (!sections) {
    throw error("network");
  }

  const ingress = network.ingress;
  const valid = port(ingress);
  const local = port(network.web.port);
  const separate = network.ingress !== network.web.port;

  let unsafe = !valid;

  if (!unsafe) {
    unsafe = !local;
  }

  if (!unsafe) {
    unsafe = !separate;
  }

  if (unsafe) {
    throw error("network");
  }

  const ca = network.ca;

  let clean = typeof ca === "string";

  if (clean) {
    clean = path.absolute(ca);
  }

  if (clean) {
    clean = !/[\r\n\0]/.test(ca);
  }

  if (!clean) {
    throw error("network");
  }

  const secret = network.secret ?? null;

  let credential = typeof secret === "string";

  if (credential) {
    credential = /^[A-Za-z0-9_-]{32,128}$/.test(secret);
  }

  let malformed = secret !== null;

  if (malformed) {
    malformed = !credential;
  }

  if (malformed) {
    throw error("network");
  }

  const entry = origin(network.entry, false);
  const funnel = origin(network.funnel, true);
  const supplied = network.origins !== undefined;
  const structured = object(network.origins);

  let mismatch = supplied;

  if (mismatch) {
    mismatch = !structured;
  }

  if (mismatch) {
    throw error("network");
  }

  const primary = origin(network.origins?.primary ?? funnel, true);
  const secondary = origin(network.origins?.secondary, true);
  const missing = !primary;
  const duplicate = secondary === primary;
  const invalid = missing || duplicate;

  if (secondary && invalid) {
    throw error("network");
  }

  const origins = { primary, secondary };
  const frontend = upstreams(network.web.upstreams);
  const backend = upstreams(network.was.upstreams);
  const number = network.web.port;
  const addresses = network.web.addresses ?? ["127.0.0.1"];
  const accepted = Array.isArray(addresses);

  let empty = !accepted;

  if (!empty) {
    empty = addresses.length === 0;
  }

  if (empty) {
    throw error("network");
  }

  for (const address of addresses) {
    const ipv4 = net.isIP(address) === 4;

    let available = !ipv4;

    if (!available) {
      available = !internal(address);
    }

    if (available) {
      throw error("network");
    }
  }

  const timeout = network.timeout ?? 3000;
  const integer = Number.isInteger(timeout);
  const minimum = timeout >= 100;
  const maximum = timeout <= 10000;

  let outside = !integer;

  if (!outside) {
    outside = !minimum;
  }

  if (!outside) {
    outside = !maximum;
  }

  if (outside) {
    throw error("network");
  }

  const web = {
    port: number,
    addresses: [...new Set(addresses)],
    upstreams: frontend,
  };

  const was = { upstreams: backend };

  const circular = [...frontend, ...backend].some(function loop(address) {
    const url = new URL(address);

    let loopback = url.hostname === "localhost";

    if (!loopback) {
      loopback = url.hostname === "[::1]";
    }

    if (!loopback) {
      loopback = url.hostname.startsWith("127.");
    }

    let selected = url.port;

    if (!selected) {
      if (url.protocol === "https:") {
        selected = 443;
      } else {
        selected = 80;
      }
    }

    const number = Number(selected);

    let equal;

    if (loopback) {
      equal = number === ingress;
    }

    const result = loopback && equal;

    return result;
  });

  if (circular) {
    throw error("network");
  }

  const settings = {
    entry,
    funnel: primary,
    origins,
    timeout,
    ingress,
    ca,
    secret,
    web,
    was,
  };

  return settings;
}

export function shared(value, settings) {
  if (!settings) {
    return value;
  }

  const entry = origin(settings.entry, false);
  const primary = origin(settings.origins?.primary ?? settings.funnel, true);
  const secondary = origin(settings.origins?.secondary, true);

  const origins = {
    primary: value.origins?.primary ?? value.funnel ?? primary,
    secondary: value.origins?.secondary ?? secondary,
  };

  const result = {
    ...value,
    entry: value.entry ?? entry,
    funnel: value.funnel ?? origins.primary,
    origins,
  };

  return parse(result);
}

export async function prepare(filename = path.network()) {
  if (!path.absolute(filename)) {
    throw error("network");
  }

  const release = await lock("service");

  try {
    const exists = await store.exists(filename);

    let common;

    if (path.system()) {
      if (filename === path.network()) {
        common = (await cluster.config())?.network;
      }
    }

    if (exists) {
      if (!common) {
        return;
      }

      const previous = await load(filename);
      const value = shared(previous, common);

      if (JSON.stringify(previous) === JSON.stringify(value)) {
        return;
      }

      const record = await store.read();
      const contents = JSON.stringify(value, null, 2) + "\n";

      await primary.write(record, filename, contents, { mode: 0o600 });

      return;
    }

    let record;

    if (path.system()) {
      record = await store.read();
    } else {
      record = null;
    }

    const services = record?.services ?? [];

    const frontend = services.find((service) => {
      return service.role === "WEB";
    });

    const backend = services.find((service) => {
      return service.role === "WAS";
    });

    const proxy = services.find((service) => {
      return service.role === "CADDY";
    });

    const settings = {
      entry: null,
      funnel: null,
      origins: { primary: null, secondary: null },
      timeout: 3000,
      secret: null,
      ingress: 8080,
      ca: path.certificate("ca", "crt"),
      web: {
        port: proxy?.port ?? 8443,
        upstreams: [frontend?.address ?? "https://localhost:8443"],
      },
      was: { upstreams: [backend?.address ?? "https://127.0.0.1:3443"] },
    };

    const value = shared(parse(settings), common);
    const contents = JSON.stringify(value, null, 2) + "\n";
    const standard = path.adjacent(path.path().config, "network.json");
    const managed = filename === standard;

    if (record && managed) {
      await primary.write(record, filename, contents, { mode: 0o600 });
    } else {
      await fs.mkdir(path.parent(filename), { recursive: true, mode: 0o700 });

      await fs.writeFile(filename, contents, { flag: "wx", mode: 0o600 });
    }
  } finally {
    await release();
  }
}

export async function load(filename = path.network()) {
  if (!path.absolute(filename)) {
    throw error("network");
  }

  try {
    const text = await fs.readFile(filename, "utf8");
    const value = JSON.parse(text);

    return parse(value);
  } catch (failure) {
    let optional = filename === path.network();

    if (optional) {
      optional = !process.env.ORBIT_NETWORK;
    }

    let valid = failure.code === "ENOENT";

    if (valid) {
      valid = optional;
    }

    if (valid) {
      return null;
    }

    throw error("network");
  }
}

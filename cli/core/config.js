import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import { error } from "#cli/core/error.js";

function preferences(settings) {
  if (!settings) {
    return false;
  }

  const language = ["auto", "ko", "en"].includes(settings.language);
  const startup = typeof settings.startup === "boolean";
  const result = language && startup;

  return result;
}

function header(manifest) {
  if (!manifest) {
    return false;
  }

  const version = manifest.version === 1;
  const installed = typeof manifest.installed === "boolean";
  const services = Array.isArray(manifest.services);
  const result = version && installed && services;

  return result;
}

function identity(service, names) {
  if (!service) {
    return false;
  }

  if (service.role === "MONITOR") {
    let result = service.name === "Monitor";

    if (result) {
      result = service.unit === "orbit-monitor.service";
    }

    if (result) {
      result = !names.has(service.name);
    }

    return result;
  }

  const name = /^(WEB[1-9]\d*|WAS[1-9]\d*|DB[1-9]\d*|Caddy)$/.test(
    service.name,
  );

  if (!name) {
    return false;
  }

  const role = ["WEB", "WAS", "DB", "CADDY"].includes(service.role);

  let response = !role;

  if (!response) {
    response = names.has(service.name);
  }

  if (response) {
    return false;
  }

  let value = service.role === "CADDY";

  if (!value) {
    value = service.name.startsWith(service.role);
  }

  return value;
}

function valid(address) {
  const protocol = ["http:", "https:"].includes(address.protocol);

  let credentials = address.username;

  if (!credentials) {
    credentials = address.password;
  }

  let result = protocol;

  if (result) {
    result = !credentials;
  }

  return result;
}

export async function config() {
  let settings;

  try {
    settings = JSON.parse(await fs.readFile(path.path().config, "utf8"));
  } catch (failure) {
    if (failure.code === "ENOENT") {
      const result = { language: "auto", startup: false };

      return result;
    }

    throw error("config");
  }

  if (!preferences(settings)) {
    throw error("config");
  }

  const { language, startup } = settings;
  const output = { language, startup };

  return output;
}

export async function save(settings) {
  let installed;

  if (path.system()) {
    installed = await store.read();
  } else {
    installed = null;
  }

  let valid = path.system();

  if (valid) {
    valid = !installed;
  }

  if (valid) {
    throw error("plan");
  }

  const directories = path.path();

  await fs.mkdir(directories.home, { recursive: true, mode: 0o700 });

  const temporary = path.child(directories.home, `config.${randomUUID()}.tmp`);

  try {
    const options = { flag: "wx", mode: 0o600 };
    const contents = JSON.stringify(settings) + "\n";

    await fs.writeFile(temporary, contents, options);

    await fs.rename(temporary, directories.config);

    if (path.system()) {
      const entry = store.entry(installed, directories.config);

      if (entry) {
        entry.hash = await store.digest(directories.config);

        await store.write(installed);
      } else if (installed) {
        const hash = await store.digest(directories.config);

        const item = {
          path: directories.config,
          type: "file",
          done: true,
          keep: false,
          hash,
          mode: 0o600,
        };

        installed.entries.push(item);

        await store.write(installed);
      }
    }
  } finally {
    await fs.unlink(temporary).catch(function missing(failure) {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function installation() {
  let manifest;

  try {
    manifest = JSON.parse(await fs.readFile(path.path().installation, "utf8"));
  } catch (failure) {
    if (failure.code === "ENOENT") {
      return null;
    }

    throw error("manifest");
  }

  if (!header(manifest)) {
    throw error("manifest");
  }

  if (!manifest.installed) {
    return null;
  }

  const names = new Set();

  for (const service of manifest.services) {
    if (!identity(service, names)) {
      throw error("manifest");
    }

    names.add(service.name);

    if (["WEB", "WAS"].includes(service.role)) {
      let address;

      try {
        address = new URL(service.address);
      } catch {
        throw error("manifest");
      }

      if (!valid(address)) {
        throw error("manifest");
      }
    }
  }

  if (path.system()) {
    const source = path.child(path.source, "cli/index.js");

    const units = manifest.services.filter((service) => {
      let result = service.unit;

      if (result) {
        result = service.role !== "MONITOR";
      }

      return result;
    });

    const files = [source, ...units.map((service) => path.unit(service.unit))];

    try {
      for (const filename of files) {
        await fs.access(filename);
      }
    } catch {
      throw error("manifest");
    }
  }

  return manifest;
}

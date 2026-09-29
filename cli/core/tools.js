import * as platform from "#cli/platform/index.js";
import * as mac from "#cli/platform/mac/tools.js";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import { error } from "#cli/core/error.js";

async function executable(name) {
  for (const candidate of path.tools(name)) {
    try {
      const binary = await fs.realpath(candidate);

      await fs.access(binary, fs.constants.X_OK);

      if (await usable(binary, name)) {
        return binary;
      }
    } catch (failure) {
      if (!["ENOENT", "EACCES", "ENOEXEC"].includes(failure.code)) {
        throw failure;
      }
    }
  }

  return null;
}

function retain(prepared, item) {
  if (!prepared) {
    return;
  }

  const present = prepared.some(function same(value) {
    return value.root === item.root;
  });

  if (!present) {
    prepared.push(item);
  }
}

async function database() {
  if (platform.mac) {
    return mac.database();
  }

  let version;

  try {
    version = (await fs.readFile(path.version, "utf8")).trim();
  } catch (failure) {
    if (failure.code !== "ENOENT") {
      throw failure;
    }
  }

  if (version) {
    return path.binary(version);
  }

  const entries = await fs
    .readdir(path.binaries)
    .catch(function absent(failure) {
      if (failure.code === "ENOENT") {
        const result = [];

        return result;
      }

      throw failure;
    });

  const versions = entries.filter(function numeric(value) {
    return /^\d+$/.test(value);
  });

  versions.sort((first, second) => {
    const result = Number(second) - Number(first);

    return result;
  });

  for (const version of versions) {
    const binary = path.binary(version);

    if (await usable(binary, "postgres")) {
      return binary;
    }
  }

  return null;
}

export async function usable(value, kind) {
  let absolute = typeof value === "string";

  if (absolute) {
    absolute = path.absolute(value);
  }

  let outcome = !absolute;

  if (!outcome) {
    let pattern;

    if (platform.mac) {
      pattern = /^\/[A-Za-z0-9_ ./@-]+$/;
    } else {
      pattern = /^\/[A-Za-z0-9_./-]+$/;
    }

    outcome = !pattern.test(value);
  }

  if (outcome) {
    return false;
  }

  let binary;

  if (kind === "postgres") {
    binary = path.child(value, "postgres");
  } else {
    binary = value;
  }

  const installed = binary.startsWith(path.provisioning + "/");

  let returned = binary.startsWith(path.source + "/");

  if (returned) {
    returned = !installed;
  }

  if (returned) {
    return false;
  }

  try {
    let details;

    if (platform.mac) {
      details = await fs.stat(binary);
    } else {
      details = await fs.lstat(binary);
    }

    await fs.access(binary, fs.constants.X_OK);

    if (!details.isFile()) {
      return false;
    }

    if (!kind) {
      return true;
    }

    const option = { allow: true };

    let native = platform.mac;

    if (native) {
      native = kind === "openssl";
    }

    let args;

    if (native) {
      args = ["version"];
    } else {
      args = ["--version"];
    }

    const report = await command.run(binary, args, option);

    if (report.code !== 0) {
      return false;
    }

    const text = report.output.trim();

    if (kind === "node") {
      const major = Number(text.match(/^v(\d+)\./)?.[1]);

      return major >= 24;
    }

    if (kind === "pnpm") {
      const version = text.match(/^(\d+)\.(\d+)\.(\d+)/);

      if (!version) {
        return false;
      }

      const [major, minor, patch] = version.slice(1).map(Number);
      const release = major === 12;
      const newer = minor > 8;

      let minimum = minor === 8;

      if (minimum) {
        minimum = patch >= 1;
      }

      const result = release && (newer || minimum);

      return result;
    }

    if (kind === "caddy") {
      if (!/^v?\d+\.\d+\.\d+/.test(text)) {
        return false;
      }

      const modules = await command.run(binary, ["list-modules"], option);
      const handlers = modules.output.split(/\r?\n/);
      const proxy = handlers.includes("http.handlers.reverse_proxy");
      const files = handlers.includes("http.handlers.file_server");
      const code = modules.code === 0;
      const resolved = code && proxy;
      const ready = resolved && files;

      return ready;
    }

    if (kind === "openssl") {
      const openssl = /^OpenSSL \d+\./.test(text);

      let libre;

      if (platform.mac) {
        libre = /^LibreSSL \d+\./.test(text);
      }

      const valid = openssl || libre;

      return valid;
    }

    const major = text.match(/PostgreSQL\) (\d+)\./)?.[1];

    if (!major) {
      return false;
    }

    let selection = platform.mac;

    if (selection) {
      selection = major !== "18";
    }

    if (selection) {
      return false;
    }

    const version = await fs
      .readFile(path.version, "utf8")
      .catch(function absent(failure) {
        if (failure.code === "ENOENT") {
          return null;
        }

        throw failure;
      });

    let available = version === null;

    if (!available) {
      available = version.trim() === major;
    }

    return available;
  } catch (failure) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes(failure.code)) {
      return false;
    }

    throw failure;
  }
}

async function response(url) {
  const signal = AbortSignal.timeout(180000);
  const headers = { "User-Agent": "Orbit", Accept: "application/json" };
  const setting = { signal, headers };
  const report = await fetch(url, setting);

  if (!report.ok) {
    throw error("dependencies", { reason: "download" });
  }

  return report;
}

async function archive(url, filename, checksum) {
  const report = await response(url);
  const contents = Buffer.from(await report.arrayBuffer());
  const hash = crypto.createHash(checksum.algorithm);

  hash.update(contents);

  if (hash.digest(checksum.encoding) !== checksum.value) {
    throw error("dependencies", { reason: "checksum" });
  }

  await fs.writeFile(filename, contents, { flag: "wx", mode: 0o600 });
}

async function extract(filename, destination) {
  const listing = ["-tf", filename];
  const report = await command.run("/usr/bin/tar", listing);
  const names = report.output.split(/\r?\n/).filter(Boolean);

  const unsafe = names.some((name) => {
    let result = name.startsWith("/");

    if (!result) {
      result = name.split("/").includes("..");
    }

    return result;
  });

  if (unsafe) {
    throw error("dependencies", { reason: "checksum" });
  }

  const args = ["-xf", filename, "-C", destination];

  await command.run("/usr/bin/tar", args);
}

async function pnpm(root) {
  const architectures = { x64: "x64", arm64: "arm64" };
  const arch = architectures[process.arch];

  if (!arch) {
    throw error("unsupported");
  }

  let system;

  if (platform.mac) {
    system = "darwin";
  } else {
    system = "linux";
  }

  const origin = `https://registry.npmjs.org/@pnpm/exe.${system}-${arch}/12.8.1`;
  const report = await response(origin);
  const metadata = await report.json();
  const integrity = metadata.dist?.integrity;

  if (!integrity?.startsWith("sha512-")) {
    throw error("dependencies");
  }

  const checksum = {
    algorithm: "sha512",
    encoding: "base64",
    value: integrity.slice(7),
  };

  const filename = path.child(root, "package.tgz");

  await archive(metadata.dist.tarball, filename, checksum);

  await extract(filename, root);

  await fs.unlink(filename);

  const binary = path.child(root, "package/pnpm");

  await fs.chmod(binary, 0o755);

  return binary;
}

async function caddy(root) {
  const architectures = { x64: "amd64", arm64: "arm64" };
  const arch = architectures[process.arch];

  if (!arch) {
    throw error("unsupported");
  }

  const origin = [
    "https://api.github.com/repos/",
    "caddyserver/caddy/releases/latest",
  ].join("");

  const report = await response(origin);
  const release = await report.json();

  let system;

  if (platform.mac) {
    system = "mac";
  } else {
    system = "linux";
  }

  const asset = release.assets.find((item) =>
    item.name.endsWith(`_${system}_${arch}.tar.gz`),
  );

  if (!asset?.digest?.startsWith("sha256:")) {
    throw error("dependencies", { reason: "checksum" });
  }

  const checksum = {
    algorithm: "sha256",
    encoding: "hex",
    value: asset.digest.slice(7),
  };

  const filename = path.child(root, "caddy.tar.gz");

  await archive(asset.browser_download_url, filename, checksum);

  await extract(filename, root);

  await fs.unlink(filename);

  return path.child(root, "caddy");
}

async function postgres(root) {
  let version;

  try {
    version = (await fs.readFile(path.version, "utf8")).trim();
  } catch (failure) {
    if (failure.code !== "ENOENT") {
      throw failure;
    }
  }

  if (!version) {
    const report = await command.run("/usr/bin/apt-cache", [
      "depends",
      "postgresql",
    ]);

    version = report.output.match(/Depends:\s+postgresql-(\d+)/)?.[1];
  }

  if (!/^\d+$/.test(version)) {
    throw error("dependencies", { reason: "executable", target: "PostgreSQL" });
  }

  const packages = [`postgresql-${version}`, `postgresql-client-${version}`];

  await unpack(root, packages);

  const bin = path.child(root, "bin");

  await fs.mkdir(bin);

  const binaries = [
    "postgres",
    "initdb",
    "pg_ctl",
    "pg_controldata",
    "pg_isready",
    "psql",
  ];

  for (const name of binaries) {
    const program = `usr/lib/postgresql/${version}/bin/${name}`;

    await wrapper(root, name, program);
  }

  return bin;
}

async function unpack(root, packages) {
  const downloads = path.child(root, "archives");

  await fs.mkdir(downloads, { mode: 0o700 });

  const options = { cwd: downloads, timeout: 300000 };

  const args = [
    "--download-only",
    "--reinstall",
    "--no-install-recommends",
    "--yes",
    "-o",
    `Dir::Cache::archives=${downloads}`,
    "install",
    ...packages,
  ];

  await command.run("/usr/bin/apt-get", args, options);

  const names = (await fs.readdir(downloads)).filter((name) =>
    name.endsWith(".deb"),
  );

  if (!names.length) {
    throw error("dependencies", { reason: "download" });
  }

  for (const name of names) {
    const filename = path.child(downloads, name);
    const args = ["--extract", filename, root];

    await command.run("/usr/bin/dpkg-deb", args);
  }

  await fs.rm(downloads, { recursive: true });
}

async function wrapper(root, name, program) {
  const lines = [
    "#!/bin/sh",
    'root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)',
    'libraries="$root/usr/lib"',
    'for directory in "$root"/usr/lib/*-linux-gnu; do',
    '  if [ -d "$directory" ]; then libraries="$libraries:$directory"; fi',
    "done",
    'export LD_LIBRARY_PATH="$libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
  ];

  if (name === "openssl") {
    lines.push('export OPENSSL_CONF="$root/openssl.cnf"');
  }

  lines.push(`exec "$root/${program}" "$@"`, "");

  const text = lines.join("\n");
  const bin = path.child(root, "bin");
  const filename = path.child(bin, name);
  const setting = { flag: "wx", mode: 0o755 };

  await fs.writeFile(filename, text, setting);
}

async function openssl(root) {
  const packages = ["openssl"];

  await unpack(root, packages);

  const bin = path.child(root, "bin");

  await fs.mkdir(bin);

  const lines = ["[req]", "distinguished_name=dn", "", "[dn]", ""];
  const contents = lines.join("\n");
  const filename = path.child(root, "openssl.cnf");
  const option = { flag: "wx", mode: 0o600 };

  await fs.writeFile(filename, contents, option);

  await wrapper(root, "openssl", "usr/bin/openssl");

  return path.child(bin, "openssl");
}

export async function resolve(name, option = {}) {
  if (await usable(option.supplied, name)) {
    return option.supplied;
  }

  let found;

  if (name === "node") {
    const candidates = [process.execPath, ...path.nodes, ...path.tools("node")];

    for (const candidate of candidates) {
      if (!(await usable(candidate, name))) {
        continue;
      }

      found = await fs.realpath(candidate);

      break;
    }
  } else if (name === "postgres") {
    found = await database();
  } else {
    found = await executable(name);
  }

  let report = found;

  if (report) {
    report = await usable(found, name);
  }

  if (report) {
    let valid = name === "node";

    if (valid) {
      valid = found.startsWith(path.runtime + "/node.");
    }

    if (valid) {
      const root = path.parent(path.parent(found));
      const item = { name, root, value: found };

      retain(option.prepared, item);
    }

    return found;
  }

  if (!option.prepared) {
    throw error("dependencies", { reason: "executable", target: name });
  }

  return prepare(name, option.prepared);
}

export async function prepare(name, prepared) {
  command.root();

  let valid = platform.mac;

  if (valid) {
    valid = ["postgres", "openssl"].includes(name);
  }

  if (valid) {
    const value = await mac.prepare(name, prepared);

    if (!(await usable(value, name))) {
      throw error("dependencies", { reason: "version", target: name });
    }

    return value;
  }

  if (name === "node") {
    const args = [path.bootstrap, path.runtime, ...path.nodes];
    const setting = { timeout: 300000 };
    const report = await command.run("/bin/sh", args, setting);
    const value = report.output.trim();

    if (!(await usable(value, name))) {
      throw error("dependencies", { reason: "version" });
    }

    if (value.startsWith(path.runtime + "/node.")) {
      const root = path.parent(path.parent(value));
      const item = { name, root, value };

      retain(prepared, item);
    }

    return value;
  }

  await store.safe(path.preparation);

  await fs.mkdir(path.preparation, { recursive: true, mode: 0o700 });

  const root = await fs.mkdtemp(path.child(path.preparation, name + "-"));
  const item = { name, root };

  prepared.push(item);

  try {
    const providers = { pnpm, caddy, postgres, openssl };
    const prepare = providers[name];

    if (!prepare) {
      throw error("dependencies", { reason: "executable", target: name });
    }

    item.value = await prepare(root);

    if (!(await usable(item.value, name))) {
      throw error("dependencies", { reason: "executable", target: name });
    }

    return item.value;
  } catch (failure) {
    if (!failure.code) {
      failure.code = "dependencies";
    }

    throw failure;
  }
}

export async function commit(record, prepared, option = {}) {
  if (!option.extend) {
    record.provenance = {};

    for (const [name, value] of Object.entries(record.tools)) {
      if (value) {
        record.provenance[name] = { owner: "system", path: value };
      }
    }
  }

  if (!prepared.length) {
    return;
  }

  const exists = await store.exists(path.provisioning);

  let output = option.extend;

  if (output) {
    output = exists;
  }

  if (output) {
    const entry = store.entry(record, path.provisioning);
    const directory = store.folder(exists);
    const root = exists.uid === 0;
    const owned = Boolean(entry);
    const valid = directory && root && owned;

    if (!valid) {
      throw error("manifest");
    }
  } else {
    await store.directory(record, path.provisioning);
  }

  for (const tool of prepared) {
    if (tool.shared) {
      record.tools[tool.name] = tool.value;
      record.provenance[tool.name] = {
        owner: "shared",
        path: tool.value,
        created: tool.created,
        formula: tool.formula,
      };

      continue;
    }

    const target = path.child(path.provisioning, tool.name);

    await store.directory(record, target);

    try {
      const setting = { recursive: true, verbatimSymlinks: true };

      await fs.cp(tool.root, target, setting);

      await fs.chmod(target, 0o755);

      if (platform.mac) {
        await mac.publish(target);
      }
    } finally {
      await store.inventory(record, target);
    }

    const relative = tool.value.slice(tool.root.length + 1);
    const value = path.child(target, relative);

    record.tools[tool.name] = value;
    record.provenance[tool.name] = { owner: "orbit", path: value };

    const prefix = tool.root + "/";

    for (const [name, origin] of Object.entries(record.tools)) {
      if (!origin?.startsWith(prefix)) {
        continue;
      }

      const relative = origin.slice(prefix.length);
      const value = path.child(target, relative);

      record.tools[name] = value;
      record.provenance[name] = { owner: "orbit", path: value };
    }
  }

  await store.write(record);
}

export async function cleanup(prepared) {
  for (const item of prepared) {
    if (item.shared) {
      continue;
    }

    let prefix;

    if (item.name === "node") {
      prefix = path.runtime + "/node.";
    } else {
      prefix = path.preparation + "/";
    }

    if (!item.root.startsWith(prefix)) {
      throw error("manifest");
    }

    let directory;

    if (item.name === "node") {
      directory = path.parent(item.root);
    } else {
      directory = item.root;
    }

    await store.safe(directory);

    await fs.rm(directory, { recursive: true, force: true });
  }

  await fs.rmdir(path.preparation).catch((failure) => {
    if (!["ENOENT", "ENOTEMPTY"].includes(failure.code)) {
      throw failure;
    }
  });
}

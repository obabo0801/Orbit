import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import * as path from "#cli/core/path.js";
import * as command from "#cli/core/process.js";
import * as store from "#cli/core/manifest.js";
import { error } from "#cli/core/error.js";

async function response(origin) {
  const signal = AbortSignal.timeout(300000);
  const headers = { "User-Agent": "Orbit", Accept: "application/json" };
  const option = { signal, headers };
  const report = await fetch(origin, option);

  if (!report.ok) {
    throw error("dependencies", { reason: "download" });
  }

  return report;
}

export async function prepare(prepared) {
  await store.safe(path.preparation);

  await fs.mkdir(path.preparation, { recursive: true, mode: 0o700 });

  const prefix = path.child(path.preparation, "postgres-");
  const root = await fs.mkdtemp(prefix);
  const item = { name: "postgres", root };

  prepared.push(item);

  const origin = [
    "https://api.github.com/repos/",
    "PostgresApp/PostgresApp/releases/latest",
  ].join("");

  const report = await response(origin);
  const release = await report.json();

  const asset = release.assets.find(function compatible(value) {
    const archive = /-18\.dmg$/.test(value.name);
    const digest = value.digest?.startsWith("sha256:");
    const valid = archive && digest;

    return valid;
  });

  if (!asset) {
    throw error("dependencies", { reason: "checksum" });
  }

  const download = await response(asset.browser_download_url);
  const contents = Buffer.from(await download.arrayBuffer());
  const hash = crypto.createHash("sha256");

  hash.update(contents);

  const digest = "sha256:" + hash.digest("hex");

  if (digest !== asset.digest) {
    throw error("dependencies", { reason: "checksum" });
  }

  const filename = path.child(root, "postgres.dmg");
  const mount = path.child(root, "mount");

  await fs.writeFile(filename, contents, { flag: "wx", mode: 0o600 });

  await fs.mkdir(mount);

  const args = [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
    filename,
  ];

  await command.run("/usr/bin/hdiutil", args, { timeout: 180000 });

  try {
    const source = path.child(mount, "Postgres.app/Contents/Versions/18");
    const target = path.child(root, "tool");
    const option = { recursive: true, verbatimSymlinks: true };

    await fs.cp(source, target, option);

    item.value = path.child(target, "bin");
  } finally {
    await command.run("/usr/bin/hdiutil", ["detach", mount]);
  }

  await fs.rmdir(mount);

  await fs.unlink(filename);

  return item.value;
}

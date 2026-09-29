import * as crypto from "node:crypto";
import * as url from "node:url";
import { defineConfig } from "vite";

export default defineConfig(function config({ command }) {
  const bytes = crypto.randomBytes(16);
  const salt = bytes.toString("hex");

  function scope(name, filename) {
    if (command !== "build") {
      return name;
    }

    const hash = crypto.createHash("sha256");

    hash.update(salt);

    hash.update(filename);

    hash.update(name);

    const text = `c${hash.digest("hex").slice(0, 16)}`;

    return text;
  }

  const address = new url.URL(".", import.meta.url);
  const root = url.fileURLToPath(address);
  const alias = { "#web": root };
  const resolve = { alias };
  const server = { host: "127.0.0.1", port: 5173, strictPort: true };
  const modules = { generateScopedName: scope };
  const css = { modules };
  const build = { sourcemap: false, minify: true, cssMinify: true };
  const settings = { root, resolve, server, css, build };

  return settings;
});

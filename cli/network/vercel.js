import * as config from "#cli/network/config.js";
import { error } from "#cli/core/error.js";
import { route } from "#cli/network/middleware.js";
import { health } from "#cli/network/caddy.js";

export function bundle(value) {
  const settings = config.parse(value);
  const files = { "vercel.json": render(settings) };

  if (settings.origins.secondary) {
    files["middleware.js"] = middleware(settings);

    const manifest = {
      private: true,
      type: "module",
      dependencies: { "@vercel/functions": "3.9.11" },
    };

    const contents = JSON.stringify(manifest, null, 2);

    files["package.json"] = contents + "\n";
  }

  const text = JSON.stringify(files, null, 2) + "\n";

  return text;
}

export function middleware(value) {
  const settings = config.parse(value);
  const entry = Boolean(settings.entry);
  const origin = Boolean(settings.origins.primary);
  const secret = Boolean(settings.secret);
  const ready = entry && origin && secret;

  if (!ready) {
    throw error("network");
  }

  const interval = health.interval * 1000;
  const passes = health.passes - 1;
  const stability = interval * passes;
  const options = { ...settings.origins, timeout: settings.timeout, stability };

  const lines = [
    'import { rewrite } from "@vercel/functions";',
    `const settings = ${JSON.stringify(options)};`,
    route.toString(),
    'export const config = { runtime: "nodejs", matcher: "/(.*)" };',
    "",
    "export default async function middleware(request) {",
    "  const options = { ...settings, secret: process.env.ORBIT_ENTRY };",
    "  const result = await route(request, options, rewrite);",
    "  return result;",
    "}",
    "",
  ];

  return lines.join("\n");
}

export function render(value) {
  const settings = config.parse(value);

  let configured = settings.entry;

  if (configured) {
    configured = settings.funnel;
  }

  if (configured) {
    configured = settings.secret;
  }

  if (!configured) {
    throw error("network");
  }

  if (settings.origins.secondary) {
    const result = {
      $schema: "https://openapi.vercel.sh/vercel.json",
      framework: null,
      installCommand: "npm install --omit=dev",
      buildCommand: "",
      proxy: { entrypoint: "middleware.js" },
    };

    const text = JSON.stringify(result, null, 2) + "\n";

    return text;
  }

  const target = { key: "x-orbit-entry" };
  const env = ["ORBIT_ENTRY"];

  const transform = {
    type: "request.headers",
    op: "set",
    target,
    args: "$ORBIT_ENTRY",
    env,
  };

  const transforms = [transform];
  const forbidden = { src: "/upload(?:/.*)?", status: 404 };

  const uncached = {
    "Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
    "x-vercel-enable-rewrite-caching": "0",
  };

  const assets = { "x-vercel-enable-rewrite-caching": "1" };
  const api = `${settings.funnel}/api/$1`;
  const health = `${settings.funnel}/health/$1`;
  const asset = `${settings.funnel}/assets/$1`;
  const destination = `${settings.funnel}/$1`;

  const routes = [
    forbidden,
    { src: "/api/(.*)", dest: api, transforms, headers: uncached },
    { src: "/health/(.*)", dest: health, transforms, headers: uncached },
    { src: "/assets/(.*)", dest: asset, transforms, headers: assets },
    { src: "/(.*)", dest: destination, transforms, headers: uncached },
  ];

  const result = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: null,
    installCommand: "",
    buildCommand: "",
    routes,
  };

  const text = JSON.stringify(result, null, 2) + "\n";

  return text;
}

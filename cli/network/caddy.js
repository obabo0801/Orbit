import * as config from "#cli/network/config.js";
import * as template from "#cli/core/template.js";
import { error } from "#cli/core/error.js";

export const health = { interval: 5, passes: 3 };

function proxy(pool, route, settings) {
  const addresses = pool.upstreams;
  const ca = settings.ca;
  const entry = settings.entry;
  const upstreams = addresses.map(JSON.stringify).join(" ");
  const secure = addresses[0].startsWith("https:");
  const trust = JSON.stringify(ca);
  const protocol = ["transport http {"];

  if (secure) {
    protocol.push(` tls_trust_pool file ${trust}`);
  }

  protocol.push("}");

  let transport;

  if (secure) {
    transport = protocol.join("\n");
  } else {
    transport = "";
  }

  let hostname;

  if (entry) {
    hostname = new URL(entry).host;
  } else {
    hostname = null;
  }

  let host;

  if (hostname) {
    host = `header_up X-Forwarded-Host ${JSON.stringify(hostname)}`;
  } else {
    host = "header_up -X-Forwarded-Host";
  }

  const lines = [
    `reverse_proxy ${upstreams} {`,
    "    lb_policy round_robin",
    `    health_uri ${route}`,
    "    health_status 200",
    `    health_interval ${health.interval}s`,
    "    health_timeout 2s",
    "    health_fails 2",
    `    health_passes ${health.passes}`,
    "    fail_duration 30s",
    "    max_fails 2",
    "    unhealthy_status 502 503 504",
    "    lb_try_duration 5s",
    "    lb_try_interval 250ms",
    "    lb_retry_match {",
    "      method GET HEAD",
    "    }",
    "    header_up -X-Orbit-Entry",
    "    header_up -Forwarded",
    `    ${host}`,
    "    header_up X-Forwarded-Proto https",
    `    ${transport}`,
    "  }",
  ];

  return lines.join("\n");
}

export function render(value) {
  const settings = config.parse(value);

  if (!settings.secret) {
    throw error("network");
  }

  const local = template.caddy(settings.web.port, {
    addresses: settings.web.addresses,
    redact: true,
  });

  const web = proxy(settings.web, "/", settings);
  const was = proxy(settings.was, "/ready", settings);
  const secret = JSON.stringify(settings.secret);

  const lines = [
    `${local}`,
    `http://:${settings.ingress} {`,
    "  bind 127.0.0.1",
    "  log {",
    "    output stderr",
    "    format filter {",
    "      wrap json",
    "      fields {",
    "        request delete",
    "        resp_headers delete",
    "      }",
    "    }",
    "  }",
    "  route {",
    "    @ordinary not path /health/ingress /health/ingress/*",
    "    log_skip @ordinary",
    "    @observed path /health/ingress /health/ingress/*",
    "    log_append @observed <role probe",
    "    log_append @observed <nonce {http.request.uri.query.nonce}",
    "    log_append @observed <start {time.now.unix_ms}",
    "    log_append @observed end {time.now.unix_ms}",
    "    log_append @observed upstream {rp.upstream.hostport}",
    "    log_append @observed upstream_duration {rp.upstream.duration_ms}",
    "    log_append @observed upstream_latency {rp.upstream.latency_ms}",
    "    @frontend path /health/ingress/web",
    "    log_append @frontend <scope web",
    "    @backend path /health/ingress/was",
    "    log_append @backend <scope was",
    "    @ingress path /health/ingress",
    "    log_append @ingress <scope ingress",
    "    @upload path /upload /upload/*",
    "    handle @upload {",
    "      header Cache-Control no-store",
    "      respond 404",
    "    }",
    "    @health path /health/ingress",
    "    handle @health {",
    "      header Cache-Control no-store",
    "      header Content-Type application/json",
    "      header X-Orbit-Probe {http.request.uri.query.nonce}",
    '      respond `{"project":"Orbit","role":"ingress"}` 200',
    "    }",
    "    @internal path /live /ready /api/live /api/ready",
    "    handle @internal {",
    "      header Cache-Control no-store",
    "      respond 404",
    "    }",
    `    @entry header X-Orbit-Entry ${secret}`,
    "    handle @entry {",
    "      @api path /api /api/* /health/ingress/was",
    "      handle @api {",
    "        route {",
    "        @probe path /health/ingress/was",
    "        vars @probe orbitprobe {http.request.uri.query.nonce}",
    "        vars @probe orbittraffic was",
    "        @probing vars orbittraffic was",
    "        header @probing >X-Orbit-Probe {vars.orbitprobe}",
    "        header @probing >X-Orbit-Traffic was",
    "        header @probing >X-Orbit-Started {env.ORBIT_INGRESS_STARTED}",
    "        header @probing >X-Orbit-Time {time.now.unix}",
    "        rewrite @probe /ready",
    "        uri @probing query -nonce",
    "        uri strip_prefix /api",
    "        header >Cache-Control no-store",
    "        header >CDN-Cache-Control no-store",
    "        header >Vercel-CDN-Cache-Control no-store",
    `        ${was}`,
    "        }",
    "      }",
    "      handle {",
    "        route {",
    "        @probe path /health/ingress/web",
    "        vars @probe orbitprobe {http.request.uri.query.nonce}",
    "        vars @probe orbittraffic web",
    "        @probing vars orbittraffic web",
    "        header @probing >X-Orbit-Probe {vars.orbitprobe}",
    "        header @probing >X-Orbit-Traffic web",
    "        header @probing >X-Orbit-Started {env.ORBIT_INGRESS_STARTED}",
    "        header @probing >X-Orbit-Time {time.now.unix}",
    "        rewrite @probe /",
    "        header {",
    "          Cache-Control no-store",
    "          CDN-Cache-Control no-store",
    "          Vercel-CDN-Cache-Control no-store",
    "          defer",
    "        }",
    "        @assets {",
    "          path /assets/*",
    "          method GET HEAD",
    "        }",
    "        header @assets {",
    '          Cache-Control "public, max-age=31536000, immutable"',
    '          CDN-Cache-Control "public, max-age=31536000, immutable"',
    '          Vercel-CDN-Cache-Control "public, max-age=31536000, immutable"',
    "          match status 200",
    "        }",
    `        ${web}`,
    "        }",
    "      }",
    "    }",
    "    handle {",
    "      header Cache-Control no-store",
    "      respond 403",
    "    }",
    "  }",
    "}",
    "",
  ];

  return lines.join("\n");
}

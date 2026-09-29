export async function route(request, settings, rewrite) {
  const start = Date.now();
  const started = globalThis.performance.now();
  const id = globalThis.crypto.randomUUID();

  const results = [
    { ready: null, reason: "not_probed" },
    { ready: null, reason: "not_probed" },
  ];

  let scope = "web";
  let origin;
  let decision = null;
  let reason = null;
  let phase = "request";
  let status = null;
  let exception = null;

  function describe(failure) {
    const entries = [];

    function visit(value, depth) {
      if (value == null) {
        return;
      }

      if (depth > 3) {
        return;
      }

      let name;

      if (typeof value.name === "string") {
        name = value.name;
      } else {
        name = "Error";
      }

      let code;

      if (typeof value.code === "string") {
        code = value.code;
      } else {
        code = null;
      }

      const named = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
      const coded = /^[A-Z][A-Z0-9_]{0,63}$/.test(code ?? "");

      if (!named) {
        name = "Error";
      }

      if (!coded) {
        code = null;
      }

      entries.push({ name, code });

      visit(value.cause, depth + 1);

      if (Array.isArray(value.errors)) {
        for (const error of value.errors.slice(0, 4)) {
          visit(error, depth + 1);
        }
      }
    }

    visit(failure, 0);

    return entries;
  }

  async function run() {
    const url = new URL(request.url);
    const path = url.pathname;

    const internal = ["/live", "/ready", "/api/live", "/api/ready"].includes(
      path,
    );

    const upload = path === "/upload";
    const nested = path.startsWith("/upload/");
    const probe = path.startsWith("/health/ingress/");
    const blocked = internal || upload || nested || probe;

    const uncached = {
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      "x-vercel-enable-rewrite-caching": "0",
      "x-orbit-request": id,
    };

    if (blocked) {
      reason = "blocked_path";

      const response = new globalThis.Response(null, {
        status: 404,
        headers: uncached,
      });

      return response;
    }

    if (!settings.secret) {
      reason = "missing_secret";

      const response = new globalThis.Response("Ingress unavailable\n", {
        status: 503,
        headers: uncached,
      });

      return response;
    }

    const api = path === "/api";
    const nestedapi = path.startsWith("/api/");
    const backend = api || nestedapi;

    if (backend) {
      scope = "was";
    } else if (path === "/health/ingress") {
      scope = "ingress";
    }

    async function check(origin, parent, index) {
      if (!origin) {
        const output = { ready: false, latency: 0, reason: "missing_origin" };

        results[index] = output;

        return output;
      }

      const start = Date.now();

      results[index] = {
        ready: null,
        reason: "pending",
        probe: { scope, start, end: null, status: null },
      };

      const started = globalThis.performance.now();
      const nonce = globalThis.crypto.randomUUID();
      const timeout = AbortSignal.timeout(settings.timeout);

      let signal;

      if (parent) {
        signal = AbortSignal.any([timeout, parent]);
      } else {
        signal = timeout;
      }

      let suffix;

      if (scope === "ingress") {
        suffix = "";
      } else {
        suffix = "/" + scope;
      }

      const address = new URL("/health/ingress" + suffix, origin);

      address.searchParams.set("nonce", nonce);

      const headers = {
        "X-Orbit-Entry": settings.secret,
        "Cache-Control": "no-store",
      };

      let phase = "fetch";
      let received = null;
      let sent = null;
      let arrival = null;
      let validated = null;
      let abort = null;
      let status = null;
      let ready = false;
      let age = null;
      let stable = scope === "ingress";
      let error = null;
      let fresh = false;
      let traffic = null;
      let valid = false;
      let timedout = false;
      let cancelled = false;
      let network = false;
      let fault = null;
      let reason = "http_status";
      let response;

      function observe() {
        let reason = "abort";

        if (signal.reason === timeout.reason) {
          reason = "timeout";
        } else if (parent?.aborted) {
          reason = "primary_ready_cancelled";
        }

        abort = {
          timestamp: Date.now(),
          latency: Math.round(globalThis.performance.now() - started),
          reason,
        };
      }

      signal.addEventListener("abort", observe, { once: true });

      try {
        sent = {
          timestamp: Date.now(),
          latency: Math.round(globalThis.performance.now() - started),
        };
        response = await fetch(address, {
          headers,
          signal,
          redirect: "manual",
          cache: "no-store",
        });
        received = Math.round(globalThis.performance.now() - started);
        arrival = Date.now();
        status = response.status;
        phase = "headers";

        const success = status === 200;

        fresh = response.headers.get("x-orbit-probe") === nonce;

        const candidate = success && fresh;

        if (candidate) {
          if (scope === "ingress") {
            phase = "body";

            const data = await response.json();
            const project = data.project === "Orbit";
            const role = data.role === "ingress";

            valid = project && role;
          } else {
            traffic = response.headers.get("x-orbit-traffic") === scope;

            const birth = Number(response.headers.get("x-orbit-started"));
            const now = Number(response.headers.get("x-orbit-time"));
            const elapsed = now - birth;

            age = elapsed * 1000;

            const finite = Number.isFinite(age);
            const positive = birth > 0;
            const settled = age >= settings.stability;

            stable = finite && positive && settled;

            if (traffic) {
              if (scope === "was") {
                phase = "body";

                const data = await response.json();

                valid = data.ready === true;
              } else {
                valid = true;
              }
            }
          }
        }

        validated = {
          timestamp: Date.now(),
          latency: Math.round(globalThis.performance.now() - started),
          body: response.bodyUsed,
        };
        ready = success && fresh && valid && stable;

        if (success) {
          if (!fresh) {
            reason = "nonce_mismatch";
          } else if (traffic === false) {
            reason = "traffic_mismatch";
          } else if (!valid) {
            reason = "invalid_readiness";
          } else if (!stable) {
            reason = "unstable";
          } else {
            reason = "ready";
          }
        }

        if (!response.bodyUsed) {
          await response.body?.cancel();
        }

        phase = "complete";
      } catch (failure) {
        error = describe(failure);

        for (const entry of error) {
          const code = entry.code ?? "";
          const dns = ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code);

          const tls = new RegExp(
            [
              "^(ERR_TLS_",
              "ERR_SSL_",
              "CERT_",
              "DEPTH_ZERO_",
              "SELF_SIGNED_",
              "UNABLE_TO_VERIFY_",
              "UNABLE_TO_GET_ISSUER_)",
            ].join("|"),
            "",
          ).test(code);

          const connection = [
            "ECONNREFUSED",
            "ECONNRESET",
            "ETIMEDOUT",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "ENETDOWN",
            "EPIPE",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_HEADERS_TIMEOUT",
            "UND_ERR_BODY_TIMEOUT",
            "UND_ERR_SOCKET",
          ].includes(code);

          if (dns) {
            fault = "dns";
          } else if (tls) {
            fault = "tls";
          } else if (connection) {
            fault = "connection";
          }

          if (fault) {
            break;
          }
        }

        timedout = timeout.aborted;

        if (timedout) {
          timedout = signal.reason === timeout.reason;
        }

        cancelled = parent?.aborted === true;

        if (cancelled) {
          cancelled = signal.reason === parent.reason;
        }

        const fetching = phase === "fetch";
        const identified = fault !== null;
        const transport = fetching || identified;
        const aborted = timedout || cancelled;
        const active = !aborted;

        network = transport && active;

        if (network) {
          fault ??= "unknown";
        }

        if (timedout) {
          reason = "timeout";
        } else if (cancelled) {
          reason = "primary_ready_cancelled";
        } else if (network) {
          reason = "network_error";
        } else {
          reason = "probe_error";
        }
      } finally {
        signal.removeEventListener("abort", observe);
      }

      const end = Date.now();
      const latency = Math.round(globalThis.performance.now() - started);

      const result = {
        ready,
        latency,
        timeout: timeout.aborted,
        timedout,
        cancelled: parent?.aborted === true,
        aborted: cancelled,
        network,
        fault,
        reason,
        probe: {
          scope,
          nonce,
          start,
          end,
          received,
          sent,
          arrival,
          validated,
          abort,
          status,
          phase,
          error,
          age,
          stable,
          fresh,
          traffic,
          valid,
        },
      };

      results[index] = result;

      return result;
    }

    const controller = new globalThis.AbortController();

    phase = "probes";

    const primary = check(settings.primary, undefined, 0);
    const secondary = check(settings.secondary, controller.signal, 1);
    const first = await primary;

    if (first.ready) {
      controller.abort();
    }

    const second = await secondary;

    results[0] = first;
    results[1] = second;
    phase = "decision";
    decision = Date.now();

    if (results[0].ready) {
      origin = settings.primary;
      reason = "primary_ready";
    } else if (results[1].ready) {
      origin = settings.secondary;
      reason = "secondary_ready";
    }

    if (!origin) {
      reason = "both_ingresses_not_ready";

      const response = new globalThis.Response("Ingress unavailable\n", {
        status: 503,
        headers: uncached,
      });

      return response;
    }

    const destination = new URL(url.pathname + url.search, origin);

    phase = "rewrite";

    const headers = new globalThis.Headers(request.headers);

    headers.set("x-orbit-entry", settings.secret);

    const asset = path.startsWith("/assets/");
    const retrieval = ["GET", "HEAD"].includes(request.method);
    const cached = asset && retrieval;

    let policy = uncached;

    if (cached) {
      policy = {
        "x-vercel-enable-rewrite-caching": "1",
        "x-orbit-request": id,
      };
    }

    const response = rewrite(destination, {
      request: { headers },
      headers: policy,
    });

    return response;
  }

  try {
    const response = await run();

    status = response.status;
    phase = "complete";

    return response;
  } catch (failure) {
    exception = describe(failure);
    reason = "middleware_error";

    throw failure;
  } finally {
    const end = Date.now();
    const latency = Math.round(globalThis.performance.now() - started);

    let selected = null;

    if (origin) {
      if (origin === settings.primary) {
        selected = 1;
      } else {
        selected = 2;
      }
    }

    console.info(
      JSON.stringify({
        role: "ingress",
        version: 3,
        id,
        timestamp: new Date(start).toISOString(),
        start,
        end,
        latency,
        scope,
        origin: origin ?? null,
        selected,
        decision,
        reason,
        phase,
        status,
        exception,
        ready: results,
      }),
    );
  }
}

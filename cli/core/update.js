import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as cluster from "#cli/core/cluster.js";
import * as git from "#cli/core/git.js";
import * as transport from "#cli/core/transport.js";
import * as command from "#cli/core/process.js";
import * as owner from "#cli/core/owner.js";
import { lock } from "#cli/core/lock.js";
import { health } from "#cli/network/caddy.js";

export async function prepare(option = {}) {
  const settings = option.config ?? (await cluster.config());

  git.check(
    settings,
    "CLUSTER",
    "Cluster configuration is required for a rolling Update.",
  );

  const local = settings.nodes.find((node) => node.id === settings.local);
  const fallback = local.update?.checkout ?? path.checkout;
  const environment = process.env.ORBIT_CHECKOUT ?? fallback;
  const checkout = option.checkout ?? environment;
  const inspection = await git.inspect(checkout, {
    installed: path.source,
    target: option.target,
  });
  const result = { ...inspection, settings };

  return result;
}

export function order(nodes) {
  function number(node) {
    const application = node.services.find((service) => service.role === "WAS");

    let name = application?.name;

    if (name == null) {
      const frontend = node.services.find((service) => service.role === "WEB");

      name = frontend?.name;
    }

    if (name) {
      return Number(name.replace(/\D/gu, ""));
    }

    return Number.MAX_SAFE_INTEGER;
  }

  return [...nodes].sort((left, right) => {
    const first = number(left);
    const second = number(right);
    const difference = first - second;

    return difference;
  });
}

async function available(settings, node, manifest) {
  const value = await cluster.collect(manifest, { config: settings });

  for (const role of ["WAS", "WEB"]) {
    const needed = node.services.some((service) => service.role === role);

    if (!needed) {
      continue;
    }

    const peer = value.reports.some((report) => {
      const application = report.role === role;
      const other = report.host?.id !== node.id;
      const ready = report.state === "ready";
      const usable = application && other && ready;

      return usable;
    });

    git.check(
      peer,
      "AVAILABILITY",
      `No healthy ${role} peer remains while ${node.id} is updated.`,
    );
  }
}

export async function run(plan, option = {}) {
  command.root();

  git.guard(plan);

  const node = order(plan.settings.nodes)[0];
  const remote = node?.id !== plan.settings.local;
  const requested = !option.check;
  const coordinated = remote && requested;

  if (coordinated) {
    git.check(node, "CLUSTER", "An Update coordinator is required.");

    const inspection = await execute(plan, { ...option, check: true });
    const complete = inspection.nodes.every((entry) => {
      const matching = entry.commit === plan.target;
      const ready = entry.state === "complete";
      const available = !entry.skipped;
      const latest = matching && ready && available;

      return latest;
    });

    const ready = inspection.state === "ready";
    const latest = ready && complete;

    if (latest) {
      return { ...inspection, state: "synced" };
    }

    return await transport.coordinate(node, plan.settings, plan.target, option);
  }

  return await execute(plan, option);
}

export async function dispatch(request, option = {}) {
  git.check(git.sha(request.target), "TARGET", "Invalid fixed target commit.");

  const plan = await prepare({
    checkout: request.checkout,
    target: request.target,
  });
  const node = order(plan.settings.nodes)[0];

  git.check(
    node?.id === plan.settings.local,
    "CLUSTER",
    "Use the configured Update coordinator.",
  );

  return await run(plan, option);
}

async function execute(plan, option = {}) {
  const settings = plan.settings;
  const nodes = order(settings.nodes);
  const id = randomUUID();
  const target = plan.target;

  const stages = [
    "preparation",
    "target",
    ...nodes.map((node) => {
      const services = node.services
        .filter((service) => ["WAS", "WEB"].includes(service.role))
        .map((service) => service.name);

      const name = services.join(", ");
      const identifier = node.id;
      const label = name || identifier;

      return label;
    }),
    "verify",
  ];

  const requests = new Map();
  const states = new Map();
  const skipped = new Map();
  const prepared = [];
  const attempted = [];
  const applied = [];
  const dispatch = option.invoke ?? transport.run;
  const inspect = option.available ?? available;
  const filename = path.temporary("deployment.json");

  let release;
  let manifest;
  let identity;
  let seen;

  let phase = "preparation";

  async function invoke(node, settings, request, option = {}) {
    return await dispatch(node, settings, request, {
      ...option,
      checkout: plan.checkout,
    });
  }

  async function step(name, state) {
    const value = { name, state, stages, target };

    if (identity) {
      const temporary = path.temporary("deployment-" + id + ".json");
      const contents = JSON.stringify({ owner: identity, value });

      let written = false;

      try {
        await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });

        written = true;

        await fs.rename(temporary, filename);
      } catch {
        if (written) {
          await fs.unlink(temporary).catch(() => {});
        }
      }
    }

    await option.progress?.(value);
  }

  async function follow() {
    if (!option.progress) {
      return;
    }

    try {
      const details = await fs.lstat(filename);

      if (!store.secure(details)) {
        return;
      }

      const text = await fs.readFile(filename, "utf8");
      const value = JSON.parse(text);
      const matching = value.value.target === target;
      const changed = text !== seen;
      const shared = matching && changed;

      if (!shared) {
        return;
      }

      const active = await owner.active(value.owner, "deployment");

      if (active !== true) {
        return;
      }

      seen = text;

      await option.progress(value.value);
    } catch {
      return;
    }
  }

  function result(state) {
    let outcome = state;

    if (skipped.size) {
      if (state !== "busy") {
        outcome = "partial";
      }
    }

    const entries = nodes.map(function entry(node) {
      const value = states.get(node.id);
      const reason = skipped.get(node.id);

      const result = {
        id: node.id,
        commit: value?.commit ?? null,
        state: value?.state ?? "unknown",
        skipped: Boolean(reason),
        code: reason?.code,
      };

      return result;
    });

    const result = { state: outcome, target, nodes: entries };

    return result;
  }

  try {
    await step("preparation", "running");

    if (!option.check) {
      release = await lock("deployment", {
        wait: true,
        signal: option.signal,
        observe: follow,
      });
      identity = await owner.create(id);
    }

    manifest = await store.read();

    for (const node of nodes) {
      option.signal?.throwIfAborted();

      phase = node.id + ":status";

      const local = node.id === settings.local;

      transport.validate(node, local);

      let checkout;

      if (local) {
        checkout = plan.checkout;
      } else {
        checkout = node.update.checkout;
      }

      const request = { id, target, checkout, action: "status" };

      requests.set(node.id, request);

      let value;

      try {
        value = await invoke(node, settings, request, {
          signal: option.signal,
        });
      } catch (failure) {
        const pending = failure.code === "UPDATE_PENDING";

        if (pending) {
          const value = await invoke(
            node,
            settings,
            { ...request, action: "info" },
            { signal: option.signal },
          );

          states.set(node.id, { ...value, pending: true });

          continue;
        }

        const disconnected = failure.code === "UPDATE_SSH";

        const unreachable = /Connection (?:refused|timed out)/u.test(
          failure.diagnostic ?? "",
        );

        const remote = !local;
        const connection = disconnected && unreachable;
        const offline = remote && connection;

        if (!offline) {
          throw failure;
        }

        skipped.set(node.id, { code: failure.code });

        continue;
      }

      git.check(
        value.repository === plan.repository,
        "ORIGIN",
        "Cluster Nodes must use the same GitHub repository.",
      );

      for (const service of node.services) {
        const found = value.services.some(
          (entry) => entry.name === service.name,
        );

        git.check(
          found,
          "IDENTITY",
          "Installed service identities do not match Cluster configuration.",
        );
      }

      states.set(node.id, value);
    }

    await step("preparation", "complete");

    await step("target", "complete");

    const pending = [...states.values()].some((value) => value.pending);

    if (pending) {
      return result("busy");
    }

    if (option.check) {
      return result("ready");
    }

    const latest = [...states.values()].every((value) => {
      const commit = value.commit === target;
      const healthy = value.state === "complete";
      const ready = commit && healthy;

      return ready;
    });

    if (latest) {
      return result("synced");
    }

    for (const node of nodes) {
      option.signal?.throwIfAborted();

      if (skipped.has(node.id)) {
        continue;
      }

      const value = states.get(node.id);
      const matching = value.commit === target;
      const healthy = value.state === "complete";
      const skip = matching && healthy;

      if (skip) {
        continue;
      }

      const request = requests.get(node.id);

      attempted.push(node);

      phase = node.id + ":prepare";

      await invoke(
        node,
        settings,
        { ...request, action: "prepare" },
        { signal: option.signal },
      );

      prepared.push(node);

      option.signal?.throwIfAborted();
    }

    for (const node of prepared) {
      option.signal?.throwIfAborted();

      const stage = stages[nodes.indexOf(node) + 2];
      const request = requests.get(node.id);

      await step(stage, "running");

      phase = node.id + ":apply";

      await inspect(settings, node, manifest);

      option.signal?.throwIfAborted();

      await invoke(node, settings, { ...request, action: "apply" });

      applied.push(node);

      option.signal?.throwIfAborted();

      await delay(health.interval * health.passes * 1000);

      const value = await invoke(node, settings, {
        ...request,
        action: "info",
      });

      git.check(
        value.commit === target,
        "COMMIT",
        "Updated Node does not match the fixed target.",
      );

      const applications = value.reports.filter((report) =>
        ["WAS", "WEB"].includes(report.role),
      );

      const ready = applications.every((report) => report.state === "ready");

      git.check(ready, "HEALTH", "The updated Node did not remain healthy.");

      states.set(node.id, value);

      await step(stage, "complete");
    }

    await step("verify", "running");

    for (const node of nodes) {
      if (skipped.has(node.id)) {
        continue;
      }

      phase = node.id + ":verify";

      const request = requests.get(node.id);

      const value = await invoke(node, settings, {
        ...request,
        action: "info",
      });

      git.check(
        value.commit === target,
        "COMMIT",
        "Cluster commits do not match the fixed target.",
      );

      git.check(
        value.state === "complete",
        "HEALTH",
        "Cluster source verification is incomplete.",
      );

      const applications = value.reports.filter((report) =>
        ["WAS", "WEB"].includes(report.role),
      );

      const ready = applications.every((report) => report.state === "ready");

      git.check(ready, "HEALTH", "Cluster application Health is incomplete.");

      states.set(node.id, value);
    }

    for (const node of applied) {
      option.signal?.throwIfAborted();

      phase = node.id + ":finish";

      await invoke(node, settings, {
        ...requests.get(node.id),
        action: "finish",
      });
    }

    await step("verify", "complete");

    return result("complete");
  } catch (cause) {
    const identified = String(cause.message).startsWith("UPDATE_");

    let failure = cause;

    if (cause.name === "AbortError") {
      failure = new Error("UPDATE_ABORT: Update was cancelled.", { cause });
      failure.code = "UPDATE_ABORT";
    } else if (!identified) {
      failure = new Error(`UPDATE_NODE: Update failed at ${phase}.`, { cause });
      failure.code = "UPDATE_NODE";
    }

    failure.phase = phase;

    const faults = [];

    for (const node of attempted) {
      if (applied.includes(node)) {
        continue;
      }

      try {
        await invoke(node, settings, {
          ...requests.get(node.id),
          action: "cancel",
        });
      } catch (cleanup) {
        faults.push({ node: node.id, code: cleanup.code ?? "UPDATE_RECOVERY" });
      }
    }

    const observations = await Promise.allSettled(
      nodes.map((node) => {
        if (skipped.has(node.id)) {
          return Promise.resolve(null);
        }

        const request = requests.get(node.id);

        if (!request) {
          return Promise.resolve(null);
        }

        return invoke(
          node,
          settings,
          { ...request, action: "info" },
          { timeout: 15000 },
        );
      }),
    );

    for (let index = 0; index < nodes.length; index++) {
      const observation = observations[index];
      const node = nodes[index];

      if (observation.status === "fulfilled") {
        if (observation.value) {
          states.set(node.id, observation.value);
        }
      } else {
        states.set(node.id, { commit: null, state: "unknown" });
      }
    }

    failure.target = target;
    failure.nodes = [...states].map(([id, value]) => {
      const result = { id, commit: value.commit };

      return result;
    });
    failure.recovery = faults;

    await option.progress?.({ state: "failed", target });

    throw failure;
  } finally {
    await release?.();
  }
}

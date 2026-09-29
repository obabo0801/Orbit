import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as primary from "#cli/core/primary.js";
import * as promotion from "#cli/core/promotion.js";
import * as authority from "#cli/core/authority.js";
import * as command from "#cli/core/process.js";

function require(value, reason) {
  if (!value) {
    throw new Error(`FAILOVER_${reason}: Failover prerequisite failed.`);
  }
}

export function classify(report, time, freshness) {
  const elapsed = time - report.time;
  const future = elapsed < 0;
  const stale = elapsed > freshness;
  const invalid = future || stale;

  if (!Number.isFinite(elapsed)) {
    return "observation";
  }

  if (invalid) {
    return "observation";
  }

  if (report.host !== true) {
    return "host";
  }

  if (report.network !== true) {
    return "partition";
  }

  if (report.replica !== true) {
    return "replica";
  }

  if (report.expected === "down") {
    return "stopped";
  }

  if (report.running === true) {
    return "normal";
  }

  if (report.running !== false) {
    return "unknown";
  }

  if (report.listener !== false) {
    return "unknown";
  }

  return "process";
}

export function identity(approval, source, target, option = {}) {
  promotion.identity(source, target);

  require(source.cluster === approval.cluster, "CLUSTER");

  require(source.timeline === approval.timeline, "TIMELINE");

  if (option.disconnected !== true) {
    require(target.receiver?.status === "streaming", "RECEIVER");

    require(target.receiver.received_tli === approval.timeline, "TIMELINE");
  }
}

export async function state() {
  const details = await store.exists(path.failover);

  if (!details) {
    return null;
  }

  require(store.secure(details), "OWNER");

  const record = await store.read();
  const entry = store.entry(record, path.failover);

  require(Boolean(entry?.hash), "OWNER");

  const hash = await store.digest(path.failover);

  require(hash === entry.hash, "OWNER");

  const result = JSON.parse(await fs.readFile(path.failover, "utf8"));

  return result;
}

async function save(journal, stage, reason) {
  journal.stage = stage;
  journal.time = Date.now();
  journal.reason = reason;

  journal.events.push({ stage, reason, time: journal.time });

  journal.events = journal.events.slice(-100);

  const record = await store.read();
  const text = JSON.stringify(journal) + "\n";

  await primary.write(record, path.failover, text);
}

export async function rejoin(source, target) {
  command.root();

  const grant = await authority.claim();

  let journal;

  try {
    journal = await state();

    require(journal?.stage === "rejoin", "STATE");

    const approval = grant.approval;

    require(approval.primary === source.address, "CONTROLLER");

    require(approval.target === target.address, "CONTROLLER");

    const descriptor = journal.result.descriptor;
    const report = await target.verify();

    require(report.cluster === descriptor.cluster, "CLUSTER");

    require(report.timeline === descriptor.timeline, "TIMELINE");

    require(report.recovery === false, "PRIMARY");

    require(typeof approval.slot === "string", "CONFIG");

    const result = await source.join({
      id: descriptor.id,
      slot: approval.slot,
    });

    require(result.recovery === true, "REPLICA");

    require(result.readonly === "on", "REPLICA");

    require(result.receiver?.status === "streaming", "RECEIVER");

    await target.attach({
      id: descriptor.id,
      host: approval.primary,
      slot: approval.slot,
    });

    journal.joined = result;

    await save(journal, "complete", "replica-rejoined");

    await authority.approve(await store.read(), {
      ...approval,
      enabled: false,
      confirmed: true,
    });

    return journal;
  } catch (failure) {
    if (journal) {
      await save(journal, "review", "FAILOVER_REJOIN");
    }

    throw failure;
  } finally {
    await grant.release();
  }
}

export async function acknowledge(source, target, option = {}) {
  command.root();

  require(option.confirmed === true, "CONFIRM");

  const grant = await authority.claim();

  try {
    const journal = await state();

    require(journal?.stage === "review", "STATE");

    require(journal.requested === false, "IRREVERSIBLE");

    const pending = journal.events.some((event) => {
      return event.stage === "promoting";
    });

    require(!pending, "IRREVERSIBLE");

    const transition = await primary.state();

    if (transition) {
      require(["complete", "joined", "aborted"].includes(
        transition.stage,
      ), "BUSY");
    }

    identity(grant.approval, await source.inspect(), await target.inspect());

    await save(journal, "normal", "administrator-verified");

    return journal;
  } finally {
    await grant.release();
  }
}

function settings(option) {
  const policy = {
    interval: option.interval ?? 1000,
    duration: option.duration ?? 15000,
    failures: option.failures ?? 3,
    freshness: option.freshness ?? 10000,
    timeout: option.timeout ?? 180000,
  };

  for (const number of Object.values(policy)) {
    require(Number.isSafeInteger(number), "POLICY");

    require(number > 0, "POLICY");

    require(number <= 300000, "POLICY");
  }

  require(policy.failures >= 2, "POLICY");

  require(policy.duration >= policy.interval, "POLICY");

  require(policy.timeout > policy.duration, "POLICY");

  return policy;
}

export async function run(source, target, option = {}) {
  command.root();

  const grant = await authority.claim();

  let journal;
  let requested = false;
  let held = false;

  try {
    const approval = grant.approval;

    require(approval.primary === source.address, "CONTROLLER");

    require(approval.target === target.address, "CONTROLLER");

    const previous = await state();

    if (previous) {
      const normal = previous.stage === "normal";
      const complete = previous.stage === "complete";
      const available = normal || complete;

      require(available, "BUSY");
    }

    const policy = settings(approval);
    const peers = option.peers ?? [];

    require(Array.isArray(peers), "CONFIG");

    journal = {
      id: randomUUID(),
      stage: "normal",
      events: [],
      failures: 0,
      since: null,
      approval,
      witness: "absent",
    };

    const before = await source.inspect();
    const initial = await target.inspect();

    identity(approval, before, initial);

    await source.preflight(approval);

    await target.preflight(approval);

    for (const peer of peers) {
      identity(approval, before, await peer.inspect());

      await peer.preflight(approval);
    }

    journal.before = before;

    await save(journal, "normal", "approved-single-controller");

    const deadline = Date.now() + policy.timeout;

    while (Date.now() < deadline) {
      const report = await source.observe(target);
      const reason = classify(report, Date.now(), policy.freshness);

      journal.observation = report;

      if (reason === "normal") {
        journal.failures = 0;
        journal.since = null;

        const first = await source.inspect();
        const second = await target.inspect();

        identity(approval, first, second);

        journal.before = first;

        await save(journal, "normal", reason);
      } else if (reason === "stopped") {
        await save(journal, "normal", reason);

        return journal;
      } else {
        if (journal.fault !== reason) {
          journal.failures = 0;
          journal.since = null;
        }

        journal.fault = reason;

        journal.failures++;

        if (journal.since === null) {
          journal.since = Date.now();
        }

        await save(journal, "suspected", reason);

        const count = journal.failures >= policy.failures;
        const elapsed = Date.now() - journal.since;
        const sustained = elapsed >= policy.duration;
        const established = count && sustained;

        if (established) {
          require(reason === "process", reason.toUpperCase());

          break;
        }
      }

      await delay(policy.interval, undefined, { signal: option.signal });
    }

    if (journal.stage === "normal") {
      return journal;
    }

    require(journal.stage === "suspected", "TIMEOUT");

    const count = journal.failures >= policy.failures;
    const duration = Date.now() - journal.since;

    require(count, "OBSERVATION");

    require(duration >= policy.duration, "OBSERVATION");

    const report = await source.observe(target);

    require(classify(report, Date.now(), policy.freshness) ===
      "process", "OBSERVATION");

    const standby = await target.inspect();

    identity(approval, journal.before, standby, { disconnected: true });

    require(standby.paused === false, "REPLAY");

    const prepared = await target.prepare();

    require(prepared.tls === true, "TLS");

    require(prepared.host === approval.target, "NETWORK");

    require(prepared.port === approval.port, "NETWORK");

    await save(journal, "fencing", "controlled-recovery");

    await source.quiesce({ id: journal.id, before: journal.before });

    held = true;

    await target.hold(journal.id);

    for (const peer of peers) {
      await peer.hold(journal.id);
    }

    const recovered = await source.recover(journal.id);
    const connected = Date.now() + 30000;

    let streaming;

    do {
      streaming = await target.inspect();

      if (streaming.receiver?.status === "streaming") {
        break;
      }

      await delay(250);
    } while (Date.now() < connected);

    identity(approval, recovered, streaming);

    require(recovered.recovered === true, "WAL");

    const original = { ...source };
    const replica = { ...target };

    replica.prepare = async () => prepared;
    original.fence = async (id) => {
      await save(journal, "fencing", "final-wal");

      const result = await source.fence(id);

      journal.fence = result;

      return result;
    };
    replica.promote = async (proof) => {
      await save(journal, "waiting", "wal-and-fencing-proven");

      const report = await source.observe(target);
      const elapsed = Date.now() - report.time;

      require(Number.isFinite(elapsed), "OBSERVATION");

      require(elapsed >= 0, "OBSERVATION");

      require(elapsed <= policy.freshness, "OBSERVATION");

      require(report.host === true, "HOST");

      require(report.network === true, "PARTITION");

      const fenced = await source.fenced(journal.id);

      promotion.fenced(fenced);

      require(fenced.position === proof.source.position, "WAL");

      require(fenced.cluster === approval.cluster, "CLUSTER");

      require(fenced.timeline === approval.timeline, "TIMELINE");

      requested = true;
      journal.requested = true;

      await save(journal, "promoting", "request");

      await target.promote(proof);
    };
    replica.verify = async () => {
      const report = await target.verify();

      journal.primary = {
        host: approval.target,
        port: approval.port,
        cluster: report.cluster,
        timeline: report.timeline,
      };

      await save(journal, "switching", "verified-primary");

      return report;
    };

    const result = await promotion.run(original, replica, {
      confirmed: true,
      id: journal.id,
      abort: false,
      host: approval.target,
      port: approval.port,
      peers,
    });

    journal.result = result;

    const first = await source.ready(result.descriptor);
    const second = await target.ready(result.descriptor);

    require(first.ready === true, "READINESS");

    require(second.ready === true, "READINESS");

    require(await option.health(result.descriptor), "HEALTH");

    await save(journal, "complete", "application-ready");

    await save(journal, "rejoin", "previous-primary-fenced");

    return journal;
  } catch (failure) {
    if (journal) {
      journal.requested = requested;

      const reversible = !requested;
      const quarantine = held && reversible;

      if (quarantine) {
        try {
          await source.quarantine(journal.id);

          journal.quarantined = true;
        } catch {
          journal.quarantined = false;
          journal.cleanup = "FAILOVER_QUARANTINE";
        }
      }

      const code = String(failure.message).split(":")[0];
      const recognized = /^(?:FAILOVER|PROMOTION)_[A-Z_]+$/u.test(code);

      let reason;

      if (recognized) {
        reason = code;
      } else {
        reason = "FAILOVER_UNAVAILABLE";
      }

      await save(journal, "review", reason);
    }

    throw failure;
  } finally {
    await grant.release();
  }
}

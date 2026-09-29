import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as command from "#cli/core/process.js";

function require(value, reason) {
  if (!value) {
    throw new Error(`PROMOTION_${reason}: Transition prerequisite failed.`);
  }
}

export function position(value) {
  require(typeof value === "string", "WAL");

  const match = value.match(/^([0-9A-F]+)\/([0-9A-F]+)$/u);

  require(match, "WAL");

  const high = BigInt("0x" + match[1]);
  const low = BigInt("0x" + match[2]);
  const result = (high << 32n) + low;

  return result;
}

export function identity(source, target) {
  const cluster = source.cluster === target.cluster;
  const identified = /^\d{10,20}$/u.test(source.cluster);
  const timeline = source.timeline === target.timeline;
  const integer = Number.isInteger(source.timeline);
  const positive = source.timeline > 0;
  const valid = cluster && identified && timeline && integer && positive;

  require(valid, "IDENTITY");

  require(source.recovery === false, "PRIMARY");

  require(source.readonly === "off", "PRIMARY");

  require(target.recovery === true, "REPLICA");

  require(target.readonly === "on", "REPLICA");

  require(target.paused === false, "REPLAY");
}

export function caught(source, target) {
  identity(source, target);

  const expected = position(source.position);

  let received = 0n;

  if (target.received) {
    received = position(target.received);
  }

  const replayed = position(target.replayed);
  const durable = received >= expected;
  const applied = replayed >= expected;
  const consistent = replayed <= received;
  const streamed = durable && applied && consistent;

  let retained = false;

  if (target.minimum) {
    const minimum = position(target.minimum.position);
    const timeline = target.minimum.timeline === source.timeline;
    const persisted = minimum >= expected;
    const consistent = replayed <= minimum;

    retained = timeline && persisted && applied && consistent;
  }

  if (target.retained) {
    const timeline = target.retained.timeline === source.timeline;
    const saved = position(target.retained.position);
    const persisted = saved >= expected;
    const preserved = timeline && persisted && applied;

    retained = retained || preserved;
  }

  const result = streamed || retained;

  return result;
}

export function fenced(source) {
  const stopped = source.process === false;
  const closed = source.listener === false;
  const socket = source.socket === false;
  const blocked = source.blocked === true;
  const state = source.state === "shut down";
  const result = stopped && closed && socket && blocked && state;

  require(result, "FENCE");
}

async function wait(source, target, option) {
  const deadline = Date.now() + option.timeout;

  do {
    const report = await target.inspect();

    if (caught(source, report)) {
      return report;
    }

    await delay(250);
  } while (Date.now() < deadline);

  throw new Error("PROMOTION_WAL_TIMEOUT: WAL catch-up timed out.");
}

export async function review(source, target, option = {}) {
  command.root();

  const before = await source.inspect();
  const standby = await target.inspect();

  require(caught(before, standby), "WAL");

  require(standby.receiver?.status === "streaming", "CONNECTION");

  const prepared = await target.prepare();
  const peers = option.peers ?? [];
  const reports = [];

  for (const peer of peers) {
    const report = await peer.inspect();

    require(caught(before, report), "WAL");

    require(report.receiver?.status === "streaming", "CONNECTION");

    const plan = await peer.preflight(prepared);

    require(plan.config === true, "CONFIG");

    require(plan.migration === true, "CONFIG");

    require(plan.backup === true, "BACKUP");

    reports.push({ report, plan });
  }

  const sourceplan = await source.preflight(prepared);

  require(sourceplan.config === true, "CONFIG");

  require(sourceplan.fencing === true, "FENCE");

  require(sourceplan.migration === true, "CONFIG");

  require(sourceplan.backup === true, "BACKUP");

  require(prepared.tls === true, "TLS");

  const result = {
    before,
    standby,
    prepared,
    peers: reports,
    source: sourceplan,
    ready: false,
    reason: "WAL_FENCE_AND_QUIESCE_REQUIRED",
  };

  return result;
}

export async function run(source, target, option = {}) {
  command.root();

  require(option.confirmed === true, "CONFIRM");

  const timeout = option.timeout ?? 30000;
  const integer = Number.isInteger(timeout);
  const positive = timeout > 0;
  const bounded = timeout <= 60000;
  const valid = integer && positive && bounded;

  require(valid, "TIMEOUT");

  const id = option.id ?? randomUUID();

  require(/^[a-f0-9-]{36}$/u.test(id), "AUTHORITY");

  const before = await source.inspect();
  const standby = await target.inspect();

  identity(before, standby);

  require(standby.receiver?.status === "streaming", "CONNECTION");

  require(standby.receiver.received_tli === before.timeline, "TIMELINE");

  const prepared = await target.prepare();

  require(prepared.tls === true, "TLS");

  require(prepared.host === option.host, "NETWORK");

  require(prepared.port === option.port, "NETWORK");

  require(typeof target.activate === "function", "NETWORK");

  const sourceplan = await source.preflight(prepared);

  require(sourceplan.config === true, "CONFIG");

  require(sourceplan.fencing === true, "FENCE");

  require(sourceplan.migration === true, "CONFIG");

  require(sourceplan.backup === true, "BACKUP");

  const peers = option.peers ?? [];

  require(Array.isArray(peers), "CONFIG");

  for (const peer of peers) {
    const report = await peer.inspect();

    require(caught(before, report), "WAL");

    const plan = await peer.preflight(prepared);

    require(plan.config === true, "CONFIG");

    require(plan.migration === true, "CONFIG");

    require(plan.backup === true, "BACKUP");
  }

  for (const node of [source, target, ...peers]) {
    require(typeof node.stopped === "function", "CONFIG");
  }

  if (peers.length > 0) {
    require(typeof target.slots === "function", "SLOT");
  }

  let held = false;
  let requested = false;
  let policy;

  try {
    const original = await source.hold(id);

    policy = original.policy;
    held = true;

    await target.hold(id);

    for (const peer of peers) {
      await peer.hold(id);
    }

    for (const node of [source, target, ...peers]) {
      const proof = await node.stopped(id);

      require(proof.id === id, "AUTHORITY");

      require(proof.stopped === true, "SESSIONS");
    }

    const barrier = await source.barrier(id);
    const checked = await wait(barrier, target, { timeout });

    require(checked.receiver?.status === "streaming", "CONNECTION");

    const fence = await source.fence(id);

    fenced(fence);

    require(fence.id === id, "AUTHORITY");

    const final = { ...barrier, position: fence.position };

    await wait(final, target, { timeout });

    for (const peer of peers) {
      await wait(final, peer, { timeout });
    }

    const verified = await source.fenced(id);

    fenced(verified);

    require(verified.id === id, "AUTHORITY");

    require(verified.position === fence.position, "WAL");

    const connection = await target.activate({
      id,
      plan: prepared,
      fence: verified,
    });

    require(connection.ssl === true, "TLS");

    require(connection.cluster === before.cluster, "IDENTITY");

    require(connection.recovery === true, "REPLICA");

    await wait(final, target, { timeout });

    requested = true;

    await source.seal(id);

    const proof = { id, source: final, fence: verified, confirmed: true };

    await target.promote(proof);

    const primary = await target.verify();

    require(primary.recovery === false, "PRIMARY");

    require(primary.readonly === "off", "WRITE");

    require(primary.cluster === before.cluster, "IDENTITY");

    require(primary.timeline > before.timeline, "TIMELINE");

    const descriptor = {
      id,
      cluster: primary.cluster,
      timeline: primary.timeline,
      host: option.host,
      port: option.port,
      policy,
      peers: prepared.replication,
    };

    await target.apply(descriptor);

    await source.apply(descriptor);

    if (peers.length > 0) {
      await target.slots(descriptor);
    }

    for (const peer of peers) {
      await peer.redirect({ descriptor, source: final });
    }

    await target.resume(id);

    await source.resume(id);

    for (const peer of peers) {
      await peer.resume(id);
    }

    const result = { id, before: barrier, fence, primary, descriptor };

    return result;
  } catch (failure) {
    const reversible = !requested;
    const enabled = option.abort !== false;
    const restore = held && reversible && enabled;

    if (restore) {
      for (const peer of peers) {
        await peer.abort(id);

        await peer.resume(id);
      }

      const standby = await target.abort(id);

      require(standby.recovery === true, "ABORT");

      const restored = await source.abort(id);

      require(restored.recovery === false, "ABORT");

      await source.resume(id);

      await target.resume(id);
    }

    throw failure;
  }
}

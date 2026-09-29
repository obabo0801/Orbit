import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as command from "#cli/core/process.js";
import * as system from "#cli/core/system.js";
import * as service from "#cli/core/service.js";
import * as replica from "#cli/core/replica.js";
import * as primary from "#cli/core/primary.js";
import * as promotion from "#cli/core/promotion.js";
import * as schedule from "#cli/core/schedule.js";
import * as backup from "#cli/core/backup.js";
import { internal } from "#cli/network/config.js";
import * as data from "#cli/core/data.js";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { lock } from "#cli/core/lock.js";
import * as platform from "#cli/core/platform.js";
import * as intent from "#cli/core/intent.js";
import * as health from "#cli/core/health.js";

function require(value, reason) {
  if (!value) {
    throw new Error(`PROMOTION_${reason}: Transition prerequisite failed.`);
  }
}

function database(record) {
  const result = record.services.find((value) => {
    return value.role === "DB";
  });

  require(result, "DATABASE");

  return result;
}

async function save(record, value) {
  const text = JSON.stringify(value) + "\n";

  await primary.write(record, path.transition, text);
}

async function state(id) {
  const value = await primary.state();

  require(value?.id === id, "AUTHORITY");

  return value;
}

async function control(record) {
  const executable = path.child(record.tools.postgres, "pg_controldata");

  const output = await command.run(executable, [path.db], {
    env: { LC_ALL: "C" },
  });

  const cluster = output.output.match(
    /^Database system identifier:\s+(\d+)$/mu,
  )?.[1];

  const state = output.output.match(/^Database cluster state:\s+(.+)$/mu)?.[1];

  const timeline = Number(
    output.output.match(/^Latest checkpoint's TimeLineID:\s+(\d+)$/mu)?.[1],
  );

  const position = output.output.match(
    /^Latest checkpoint location:\s+([0-9A-F/]+)$/mu,
  )?.[1];

  const result = { cluster, state, timeline, position };

  return result;
}

export async function status(record) {
  command.root();

  const entry = database(record);
  const report = await system.state(entry);
  const details = await control(record);
  const requests = await intent.read();
  const expected = requests?.services?.[entry.name]?.state;
  const active = report.ActiveState === "active";
  const process = Number(report.MainPID) > 0;
  const running = active && process;
  const listener = await listening(entry.port);

  const result = {
    ...details,
    host: true,
    running,
    listener,
    expected,
    time: Date.now(),
  };

  return result;
}

export async function quiesce(record, option) {
  command.root();

  const release = await lock("promotion");

  try {
    const previous = await primary.state();

    if (previous) {
      require(["complete", "joined", "aborted"].includes(
        previous.stage,
      ), "BUSY");
    }

    const details = await status(record);

    require(details.running === false, "PROCESS");

    require(details.listener === false, "LISTENER");

    require(details.cluster === option.before.cluster, "IDENTITY");

    require(details.timeline === option.before.timeline, "TIMELINE");

    require(database(record).mode === "primary", "PRIMARY");

    require(/^[a-f0-9-]{36}$/u.test(option.id), "AUTHORITY");

    let policy = null;

    if (await store.exists(backup.filename)) {
      policy = JSON.parse(await fs.readFile(backup.filename, "utf8"));
    }

    const authentication = await fs.readFile(path.authentication, "utf8");

    const value = {
      id: option.id,
      stage: "held",
      before: option.before,
      policy,
      authentication,
    };

    await save(record, value);

    await schedule.remove(record);

    await service.execute("stop", record, { target: "WAS" });

    const variables = parseEnv(await fs.readFile(path.was, "utf8"));

    require(/^[a-z_][a-z0-9_]*$/u.test(variables.DB_USER), "CONFIG");

    require(/^[a-z_][a-z0-9_]*$/u.test(variables.DB_NAME), "CONFIG");

    const rules = [
      "local " + variables.DB_NAME + " " + variables.DB_USER + " reject",
      "host " +
        variables.DB_NAME +
        " " +
        variables.DB_USER +
        " 0.0.0.0/0 reject",
      "host " + variables.DB_NAME + " " + variables.DB_USER + " ::0/0 reject",
      authentication.trimEnd(),
      "",
    ];

    await primary.write(record, path.authentication, rules.join("\n"), {
      mode: 0o644,
    });

    const result = { id: option.id, policy };

    return result;
  } finally {
    await release();
  }
}

export async function quarantine(record, id) {
  command.root();

  const value = await state(id);
  const held = value.stage === "held";
  const fenced = value.stage === "fenced";
  const allowed = held || fenced;

  require(allowed, "STATE");

  await service.execute("stop", record, { target: "DB" });

  await primary.write(record, path.blocked, id + "\n");

  await system.fence(record, database(record), true);
}

export async function recover(record, id) {
  command.root();

  const value = await state(id);

  require(value.stage === "held", "STATE");

  require(typeof value.authentication === "string", "CONFIG");

  await service.execute("start", record, { target: "DB", id });

  const report = await available(record);

  require(report.recovery === false, "PRIMARY");

  require(report.cluster === value.before.cluster, "IDENTITY");

  require(report.timeline === value.before.timeline, "TIMELINE");

  const result = { ...report, recovered: true };

  return result;
}

export async function ready(record, descriptor) {
  command.root();

  const variables = parseEnv(await fs.readFile(path.was, "utf8"));

  require(variables.DB_HOST === descriptor.host, "CONFIG");

  require(Number(variables.DB_PORT) === descriptor.port, "CONFIG");

  const sql = [
    "SELECT json_build_object('recovery',",
    "pg_is_in_recovery(),'tls',",
    "(SELECT ssl FROM pg_stat_ssl ",
    "WHERE pid=pg_backend_pid()))",
  ].join("");

  const connection = await replica.query(record, variables, sql);

  require(connection.recovery === false, "PRIMARY");

  require(connection.tls === true, "TLS");

  const reports = await health.health(record);

  const was = reports.find((report) => {
    return report.role === "WAS";
  });

  require(was?.ready === true, "READINESS");

  const settings = parseEnv(await fs.readFile(path.database, "utf8"));
  const writable = database(record).mode === "primary";
  const enabled = settings.DB_ENABLED === "true";

  require(writable === enabled, "CONFIG");

  if (!writable) {
    const policy = JSON.parse(await fs.readFile(backup.filename, "utf8"));

    require(policy.enabled === false, "BACKUP");
  }

  const result = {
    ready: true,
    tls: true,
    primary: true,
    migration: writable,
    backup: writable,
  };

  return result;
}

export async function preflight(record, option) {
  command.root();

  require(internal(option.primary), "NETWORK");

  require(internal(option.target), "NETWORK");

  for (const filename of [
    path.was,
    path.database,
    path.administrator,
    path.certificate("ca", "crt"),
  ]) {
    const entry = store.entry(record, filename);

    require(Boolean(entry?.hash), "CONFIG");

    const hash = await store.digest(filename);

    require(hash === entry.hash, "CONFIG");
  }

  require(Boolean(await store.exists(path.file("db", "migrate.js"))), "TOOLS");

  require(Boolean(await store.exists(path.file("db", "backup.js"))), "TOOLS");

  const variables = parseEnv(await fs.readFile(path.was, "utf8"));

  require(variables.DB_HOST === option.primary, "CONFIG");

  require(Number(variables.DB_PORT) === option.port, "CONFIG");

  const entry = database(record);
  const filename = path.unit(entry.unit);
  const registered = store.entry(record, filename);

  require(Boolean(registered?.hash), "FENCE");

  const hash = await store.digest(filename);

  require(hash === registered.hash, "FENCE");

  const result = { config: true, migration: true, backup: true, fencing: true };

  return result;
}

async function listening(port) {
  return await system.listener(port);
}

async function erase(filename, identity) {
  const details = await fs.lstat(filename);
  const root = details.uid === 0;
  const database = details.uid === identity.uid;
  const owner = root || database;

  require(owner, "OWNER");

  require(!details.isSymbolicLink(), "OWNER");

  if (details.isDirectory()) {
    for (const name of await fs.readdir(filename)) {
      await erase(path.child(filename, name), identity);
    }

    await fs.rmdir(filename);
  } else {
    require(details.isFile(), "OWNER");

    require(details.nlink === 1, "OWNER");

    await fs.unlink(filename);
  }
}

async function initialize(record, value, connection) {
  const temporary = path.adjacent(path.db, ".rejoin-" + value.id);
  const previous = path.adjacent(path.db, ".previous-" + value.id);

  require(!(await store.exists(previous)), "OWNER");

  await store.directory(record, temporary, { mode: 0o700 });

  const identity = record.identities.orbitdb;

  await fs.chown(temporary, identity.uid, identity.gid);

  const args = [
    "-D",
    temporary,
    "-d",
    connection,
    "-X",
    "stream",
    "--checkpoint=fast",
    "--manifest-checksums=SHA256",
    "--no-password",
  ];

  try {
    await platform.host.user(
      "orbitdb",
      path.child(record.tools.postgres, "pg_basebackup"),
      args,
      { timeout: 300000 },
    );

    await command.run(
      path.child(record.tools.postgres, "pg_verifybackup"),
      [temporary],
      { timeout: 120000 },
    );
  } catch (failure) {
    await erase(temporary, record.identities.orbitdb);

    record.entries = record.entries.filter((entry) => {
      return entry.path !== temporary;
    });

    await store.write(record);

    throw failure;
  }

  value.previous = previous;

  await save(record, value);

  await data.stopped(record);

  await fs.rename(path.db, previous);

  await fs.rename(temporary, path.db);

  record.entries = record.entries.filter((entry) => {
    return entry.path !== temporary;
  });

  await store.write(record);
}

async function available(record) {
  const deadline = Date.now() + 30000;

  while (true) {
    try {
      return await inspect(record);
    } catch (failure) {
      const diagnostic = failure.diagnostic ?? "";

      const pending = /Connection refused|database system is starting up/u.test(
        diagnostic,
      );

      if (!pending) {
        throw failure;
      }

      if (Date.now() >= deadline) {
        throw failure;
      }

      await delay(250);
    }
  }
}

async function retained(value) {
  const end = promotion.position(value.position);
  const size = BigInt(value.size);

  require(size > 0n, "WAL");

  require(end > 0n, "WAL");

  const segment = (end - 1n) / size;
  const count = 0x100000000n / size;
  const parts = [BigInt(value.timeline), segment / count, segment % count];

  const name = parts
    .map((part) => {
      const result = part.toString(16).toUpperCase().padStart(8, "0");

      return result;
    })
    .join("");

  require(/^[0-9A-F]{24}$/u.test(name), "WAL");

  const filename = path.child(path.child(path.db, "pg_wal"), name);
  const details = await fs.lstat(filename);

  require(details.isFile(), "WAL");

  require(!details.isSymbolicLink(), "WAL");

  const length = Number(end - segment * size);
  const handle = await fs.open(filename, "r");

  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(65536);

    let offset = 0;

    while (offset < length) {
      const remaining = length - offset;
      const limit = Math.min(buffer.length, remaining);
      const report = await handle.read(buffer, 0, limit, offset);

      require(report.bytesRead > 0, "WAL");

      digest.update(buffer.subarray(0, report.bytesRead));

      offset += report.bytesRead;
    }

    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function inspect(record) {
  command.root();

  const result = await replica.snapshot(record);

  const sql = [
    "SELECT json_build_object(",
    "'history',coalesce((SELECT json_agg(history) FROM",
    "(SELECT id,hash,time FROM public.orbit_migration ORDER BY id) history),'[]'::json),",
    "'schema',(SELECT " +
      "md5(string_agg(attname||':'||format_type(atttypid,atttypmod)" +
      "||':'||attnotnull,',' ORDER BY attnum))",
    "FROM pg_attribute WHERE attrelid='public.orbit_migration'::regclass AND attnum>0))",
  ].join(" ");

  const details = await replica.local(record, sql);
  const combined = { ...result, ...details };
  const value = await primary.state();
  const held = value?.stage === "held";
  const evidence = value?.wal;
  const checking = held && evidence;

  if (checking) {
    require(evidence.cluster === result.cluster, "IDENTITY");

    require(evidence.timeline === result.timeline, "TIMELINE");

    const received = promotion.position(evidence.received);
    const replayed = promotion.position(evidence.replayed);
    const expected = promotion.position(evidence.position);

    require(received >= expected, "WAL");

    require(replayed >= expected, "WAL");

    require((await retained(evidence)) === evidence.hash, "WAL");

    combined.retained = {
      position: evidence.position,
      timeline: evidence.timeline,
    };
  }

  return combined;
}

export async function prepare(record, option) {
  command.root();

  require(Boolean(await store.exists(path.file("db", "migrate.js"))), "TOOLS");

  require(Boolean(await store.exists(path.file("db", "backup.js"))), "TOOLS");

  require(internal(option.host), "NETWORK");

  require(internal(option.peer), "NETWORK");

  const peers = option.peers ?? [option.peer];

  require(Array.isArray(peers), "NETWORK");

  require(peers.length > 0, "NETWORK");

  for (const peer of peers) {
    require(internal(peer), "NETWORK");
  }

  const replication = option.replication ?? [];

  require(Array.isArray(replication), "CONFIG");

  const slots = new Set();
  const users = new Set();

  for (const peer of replication) {
    require(peers.includes(peer.host), "NETWORK");

    require(/^orbit_[a-z0-9_]+$/u.test(peer.slot), "SLOT");

    require(/^orbit[a-z0-9_]+$/u.test(peer.user), "CONFIG");

    require(!slots.has(peer.slot), "SLOT");

    require(!users.has(peer.user), "CONFIG");

    slots.add(peer.slot);

    users.add(peer.user);

    if (peer.password) {
      await credential(record, peer);
    }
  }

  const entry = database(record);
  const readonly = (await replica.snapshot(record)).recovery;

  require(readonly, "REPLICA");

  const certificate = path.certificate("db", "crt");
  const leaf = new X509Certificate(await fs.readFile(certificate));

  const authority = new X509Certificate(
    await fs.readFile(path.certificate("ca", "crt")),
  );

  require(leaf.checkIP(option.host) === option.host, "TLS");

  require(leaf.verify(authority.publicKey), "TLS");

  const contents = await fs.readFile(path.postgres, "utf8");
  const address = "listen_addresses='127.0.0.1," + option.host + "'";
  const configured = contents.replace(/^listen_addresses=.*$/mu, address);

  require(configured.includes(address), "NETWORK");

  const limited = configured.replace(
    /^max_slot_wal_keep_size=.*$/mu,
    "max_slot_wal_keep_size='1GB'",
  );

  const present = /^max_slot_wal_keep_size=/mu.test(limited);

  let settings = limited;

  if (!present) {
    const lines = [limited.trimEnd(), "max_slot_wal_keep_size='1GB'", ""];

    settings = lines.join("\n");
  }

  const lines = [
    "local all all scram-sha-256",
    "hostssl all all 127.0.0.1/32 scram-sha-256",
    ...[...new Set([...peers, option.host])].flatMap((address) => [
      "hostssl orbit orbit " + address + "/32 scram-sha-256",
      "hostssl all orbitadmin " + address + "/32 scram-sha-256",
      "hostssl replication orbitreplica " + address + "/32 scram-sha-256",
    ]),
    ...replication.map((peer) => {
      const prefix = "hostssl replication " + peer.user + " ";
      const suffix = peer.host + "/32 scram-sha-256";
      const line = prefix + suffix;

      return line;
    }),
    "host all all 0.0.0.0/0 reject",
    "host all all ::0/0 reject",
    "",
  ];

  const files = [];

  for (const [filename, contents] of [
    [path.postgres, settings],
    [path.authentication, lines.join("\n")],
  ]) {
    const registered = store.entry(record, filename);
    const hash = await store.digest(filename);

    require(registered?.hash === hash, "CONFIG");

    files.push({ path: filename, hash, contents });
  }

  const result = {
    tls: true,
    host: option.host,
    port: entry.port,
    peers,
    replication,
    files,
  };

  return result;
}

export async function stopped(record, id) {
  command.root();

  const value = await state(id);

  require(value.stage === "held", "STATE");

  const services = record.services.filter((entry) => {
    return entry.role === "WAS";
  });

  for (const entry of services) {
    const report = await system.state(entry);
    const inactive = report.ActiveState === "inactive";
    const failed = report.ActiveState === "failed";
    const stopped = inactive || failed;

    require(stopped, "PROCESS");

    require(Number(report.MainPID) === 0, "PROCESS");
  }

  const processes = await command.run("/bin/ps", ["-axo", "pid=,args="]);

  const active = processes.output.split("\n").some((line) => {
    const operation = /(?:^|[\s/])(?:migrate|backup)\.js(?:\s|$)/u.test(line);
    const was = line.includes(path.file("was", "index.js"));
    const active = operation || was;

    return active;
  });

  require(!active, "SESSIONS");

  const result = { id, stopped: true };

  return result;
}

export async function activate(record, option) {
  command.root();

  const journal = await state(option.id);

  require(journal.stage === "held", "STATE");

  promotion.fenced(option.fence);

  require(option.fence.id === option.id, "AUTHORITY");

  require(option.fence.cluster === journal.before.cluster, "IDENTITY");

  require(option.fence.timeline === journal.before.timeline, "TIMELINE");

  const before = await inspect(record);

  const reference = {
    ...journal.before,
    recovery: false,
    readonly: "off",
    position: option.fence.position,
  };

  require(promotion.caught(reference, before), "WAL");

  const candidate = option.plan;

  const planned = await prepare(record, {
    host: candidate.host,
    peer: candidate.peers[0],
    peers: candidate.peers,
    replication: candidate.replication,
  });

  require(JSON.stringify(planned) === JSON.stringify(candidate), "CONFIG");

  require(!journal.network, "STATE");

  const size = await replica.local(
    record,
    "SELECT to_json(setting::bigint) FROM pg_settings WHERE name='wal_segment_size'",
  );

  journal.wal = {
    cluster: before.cluster,
    timeline: before.timeline,
    position: option.fence.position,
    received: before.received,
    replayed: before.replayed,
    size,
  };
  journal.wal.hash = await retained(journal.wal);

  journal.network = [];

  for (const file of planned.files) {
    const contents = await fs.readFile(file.path, "utf8");

    journal.network.push({ path: file.path, contents });
  }

  await save(record, journal);

  for (const file of planned.files) {
    await primary.write(record, file.path, file.contents, { mode: 0o644 });
  }

  await service.execute("restart", record, { target: "DB", id: option.id });

  const result = await probe(record, planned);

  require(result.ssl === true, "TLS");

  require(result.recovery === true, "REPLICA");

  require(result.cluster === journal.before.cluster, "IDENTITY");

  return result;
}

export async function probe(record, option) {
  command.root();

  require(internal(option.host), "NETWORK");

  const stored = await store.exists(path.replica);

  let filename;

  if (stored) {
    filename = path.replica;
  } else {
    filename = path.database;
  }

  const config = parseEnv(await fs.readFile(filename, "utf8"));

  if (!stored) {
    const login = parseEnv(await fs.readFile(path.administrator, "utf8"));

    config.DB_USER = login.PGUSER;
    config.DB_PASSWORD = login.PGPASSWORD;
  }

  config.DB_HOST = option.host;
  config.DB_PORT = String(option.port);

  const sql = [
    "SELECT json_build_object('cluster',",
    "(SELECT system_identifier::text ",
    "FROM pg_control_system()),'recovery',",
    "pg_is_in_recovery(),'ssl',",
    "(SELECT ssl FROM pg_stat_ssl ",
    "WHERE pid=pg_backend_pid()))",
  ].join("");

  return await replica.query(record, config, sql);
}

export async function hold(record, id) {
  const release = await lock("promotion");

  try {
    return await held(record, id);
  } finally {
    await release();
  }
}

async function held(record, id) {
  command.root();

  require(/^[a-f0-9-]{36}$/u.test(id), "AUTHORITY");

  const previous = await primary.state();
  const matching = previous?.id === id;
  const holding = previous?.stage === "held";
  const retained = matching && holding;

  if (retained) {
    const result = { id, policy: previous.policy };

    return result;
  }

  let active = previous;

  if (active) {
    active = !["complete", "joined", "aborted"].includes(previous.stage);
  }

  require(!active, "BUSY");

  const before = await inspect(record);
  const filename = backup.filename;

  let policy = null;

  if (await store.exists(filename)) {
    policy = JSON.parse(await fs.readFile(filename, "utf8"));
  }

  const value = { id, stage: "held", before, policy };

  await save(record, value);

  await schedule.remove(record);

  await service.execute("stop", record, { target: "WAS" });

  const result = { id, policy };

  return result;
}

export async function barrier(record, id) {
  command.root();

  const value = await state(id);

  require(value.stage === "held", "STATE");

  const deadline = Date.now() + 30000;

  let report;

  do {
    report = await inspect(record);

    const sessions = report.sessions === 0;
    const transactions = report.prepared === 0;
    const idle = sessions && transactions;

    if (idle) {
      break;
    }

    await delay(250);
  } while (Date.now() < deadline);

  require(report.sessions === 0, "SESSIONS");

  require(report.prepared === 0, "TRANSACTION");

  require(report.recovery === false, "PRIMARY");

  await replica.local(record, "CHECKPOINT; SELECT to_json(true)");

  report = await inspect(record);
  value.barrier = report;

  await save(record, value);

  return report;
}

export async function fenced(record, id) {
  command.root();

  const value = await state(id);
  const entry = database(record);
  const details = await control(record);
  const status = await system.state(entry);
  const processes = await command.run("/bin/ps", ["-axo", "pid=,uid=,args="]);
  const uid = record.identities.orbitdb.uid;

  const process = processes.output.split("\n").some((line) => {
    const match = line.trim().match(/^\d+\s+(\d+)\s+(.+)$/u);
    const matching = Number(match?.[1]) === uid;

    return matching;
  });

  const listener = await listening(entry.port);

  const socket = Boolean(
    await store.exists(path.child(path.socket, ".s.PGSQL." + entry.port)),
  );

  const blocked = Boolean(await store.exists(path.blocked));
  const native = await system.fenced(record, entry);

  require(native, "FENCE");

  const stopped = status.ActiveState === "inactive";
  const absent = Number(status.MainPID) === 0;
  const valid = stopped && absent;

  require(valid, "PROCESS");

  const result = {
    ...details,
    id: value.id,
    process,
    listener,
    socket,
    blocked,
  };

  promotion.fenced(result);

  require(result.cluster === value.before.cluster, "IDENTITY");

  require(result.timeline === value.before.timeline, "TIMELINE");

  return result;
}

export async function fence(record, id) {
  command.root();

  const value = await state(id);

  require(value.barrier, "WAL");

  await service.execute("stop", record, { target: "DB" });

  if (value.authentication) {
    await primary.write(record, path.authentication, value.authentication, {
      mode: 0o644,
    });

    delete value.authentication;
  }

  await primary.write(record, path.blocked, id + "\n");

  await system.fence(record, database(record), true);

  value.stage = "fenced";

  await save(record, value);

  return await fenced(record, id);
}

export async function promote(record, option) {
  command.root();

  require(option.confirmed === true, "CONFIRM");

  const journal = await state(option.id);

  require(journal.stage === "held", "STATE");

  promotion.fenced(option.fence);

  require(option.fence.id === journal.id, "AUTHORITY");

  require(option.fence.cluster === journal.before.cluster, "IDENTITY");

  require(option.fence.timeline === journal.before.timeline, "TIMELINE");

  require(option.fence.position === option.source.position, "WAL");

  const before = await inspect(record);

  require(promotion.caught(option.source, before), "WAL");

  journal.stage = "promoting";

  await save(record, journal);

  const accepted = await replica.local(
    record,
    "SELECT to_json(pg_promote(false))",
  );

  require(accepted === true, "REQUEST");

  const deadline = Date.now() + 30000;

  do {
    const report = await replica.snapshot(record);

    if (!report.recovery) {
      journal.stage = "promoted";

      await save(record, journal);

      return;
    }

    await delay(250);
  } while (Date.now() < deadline);

  throw new Error("PROMOTION_TIMEOUT: Transition timed out.");
}

export async function seal(record, id) {
  command.root();

  const value = await state(id);

  require(value.stage === "fenced", "STATE");

  const proof = await fenced(record, id);

  value.stage = "sealed";

  await save(record, value);

  return proof;
}

export async function attach(record, option) {
  command.root();

  const value = await state(option.id);

  require(value.stage === "complete", "STATE");

  require(database(record).mode === "primary", "PRIMARY");

  require(internal(option.host), "NETWORK");

  require(/^orbit_[a-z0-9_]+$/u.test(option.slot), "SLOT");

  const report = await replica.primary(record);

  const connected = report.senders.some((sender) => {
    const slot = sender.application_name === option.slot;
    const host = sender.client_addr === option.host;
    const streaming = sender.state === "streaming";
    const encrypted = sender.ssl === true;
    const result = slot && host && streaming && encrypted;

    return result;
  });

  require(connected, "CONNECTION");

  const peers = record.replication.peers ?? [];

  record.replication.peers = peers.filter((peer) => {
    return peer.slot !== option.slot;
  });

  record.replication.peers.push({ host: option.host, slot: option.slot });

  await store.write(record);

  return report;
}

export async function verify(record) {
  command.root();

  const sql = [
    "BEGIN;",
    "CREATE TEMP TABLE orbit_promotion_probe (id integer) ON COMMIT DROP;",
    "INSERT INTO orbit_promotion_probe VALUES (1);",
    "SELECT to_json(count(*)) FROM orbit_promotion_probe;",
    "COMMIT;",
  ].join(" ");

  const result = await replica.local(record, sql);

  require(result === 1, "WRITE");

  await replica.local(record, "CHECKPOINT; SELECT to_json(true)");

  const report = await inspect(record);
  const value = await primary.state();

  require(report.schema === value.before.schema, "SCHEMA");

  require(JSON.stringify(report.history) ===
    JSON.stringify(value.before.history), "HISTORY");

  return report;
}

export async function apply(record, descriptor) {
  command.root();

  const journal = await state(descriptor.id);

  require(internal(descriptor.host), "NETWORK");

  const port = Number.isInteger(descriptor.port);
  const valid = descriptor.port > 0;
  const bounded = descriptor.port <= 65535;
  const accepted = port && valid && bounded;

  require(accepted, "NETWORK");

  require(descriptor.cluster === journal.before.cluster, "IDENTITY");

  require(descriptor.timeline > journal.before.timeline, "TIMELINE");

  const promoted = journal.stage === "promoted";
  const fenced = journal.stage === "fenced";
  const sealed = journal.stage === "sealed";
  const authorized = promoted || fenced || sealed;

  require(authorized, "STATE");

  const text = await fs.readFile(path.was, "utf8");
  const variables = parseEnv(text);

  variables.DB_HOST = descriptor.host;
  variables.DB_PORT = String(descriptor.port);
  variables.DB_CA = path.certificate("ca", "crt");

  const lines = Object.entries(variables).map(([name, contents]) => {
    const result = name + "=" + JSON.stringify(contents);

    return result;
  });

  await primary.write(record, path.was, [...lines, ""].join("\n"));

  const entries = Object.entries(variables).filter(([name]) =>
    name.startsWith("DB_"),
  );

  const configuration = Object.fromEntries(entries);

  if (promoted) {
    configuration.DB_ENABLED = "true";
  } else {
    configuration.DB_ENABLED = "false";
  }

  if (promoted) {
    configuration.DB_HOST = "127.0.0.1";
  } else {
    configuration.DB_HOST = descriptor.host;
  }

  configuration.DB_BACKUP_PATH = path.backup;
  configuration.DB_TEMPORARY_PATH = path.runtime;

  const contents = Object.entries(configuration).map(([name, contents]) => {
    const result = name + "=" + JSON.stringify(contents);

    return result;
  });

  await primary.write(record, path.database, [...contents, ""].join("\n"));

  const entry = database(record);

  if (promoted) {
    entry.mode = "primary";
  } else {
    entry.mode = "replica";
  }

  if (promoted) {
    const credentials = parseEnv(await fs.readFile(path.replica, "utf8"));

    const login = [
      "PGUSER=" + credentials.DB_USER,
      "PGPASSWORD=" + credentials.DB_PASSWORD,
      "",
    ];

    await primary.write(record, path.administrator, login.join("\n"));

    record.replication = { role: "primary", peers: [], limit: "1GB" };
  } else {
    record.replication = {
      role: "replica",
      host: descriptor.host,
      port: descriptor.port,
    };

    if (await store.exists(backup.filename)) {
      const policy = JSON.parse(await fs.readFile(backup.filename, "utf8"));

      policy.enabled = false;

      await primary.write(
        record,
        backup.filename,
        JSON.stringify(policy) + "\n",
      );
    }
  }

  journal.descriptor = descriptor;
  journal.stage = "applied";

  await store.write(record);

  await save(record, journal);
}

export async function resume(record, id) {
  command.root();

  const value = await state(id);

  require(["applied", "aborted", "joined", "complete"].includes(
    value.stage,
  ), "STATE");

  await service.execute("start", record, { target: "WAS" });

  const entry = database(record);
  const writable = entry.mode !== "replica";

  if (writable) {
    const variables = parseEnv(await fs.readFile(path.database, "utf8"));

    variables.DB_HOST = "127.0.0.1";

    const lines = Object.entries(variables).map(([name, contents]) => {
      const result = name + "=" + JSON.stringify(contents);

      return result;
    });

    await primary.write(record, path.database, [...lines, ""].join("\n"));
  }

  const policy = value.descriptor?.policy ?? value.policy;

  if (writable && policy) {
    await backup.configure(record, policy);
  }

  if (entry.mode !== "replica") {
    value.stage = "complete";

    await save(record, value);
  }
}

export async function abort(record, id) {
  command.root();

  const journal = await primary.state();

  if (!journal) {
    return await inspect(record);
  }

  require(journal.id === id, "AUTHORITY");

  require(["held", "fenced", "aborted"].includes(
    journal.stage,
  ), "IRREVERSIBLE");

  if (journal.network) {
    await service.execute("stop", record, { target: "DB" });

    for (const file of journal.network) {
      const allowed = [path.postgres, path.authentication].includes(file.path);

      require(allowed, "CONFIG");

      await primary.write(record, file.path, file.contents, { mode: 0o644 });
    }

    delete journal.network;
  }

  if (journal.authentication) {
    await primary.write(record, path.authentication, journal.authentication, {
      mode: 0o644,
    });

    delete journal.authentication;
  }

  await primary.remove(record, path.blocked);

  await system.fence(record, database(record), false);

  journal.stage = "aborted";

  await save(record, journal);

  await service.execute("start", record, { target: "DB" });

  return await available(record);
}

async function credential(record, option) {
  const user = option.user ?? "orbitreplica";

  require(/^orbit[a-z0-9_]+$/u.test(user), "CONFIG");

  const passfile = option.password ?? path.passfile;
  const details = await fs.lstat(passfile);

  require(Boolean(details.isFile()), "CONFIG");

  require(!details.isSymbolicLink(), "CONFIG");

  require((details.mode & 0o077) === 0, "CONFIG");

  const owned = details.uid === 0;
  const account = details.uid === record.identities.orbitdb.uid;

  require(owned || account, "CONFIG");

  const existing = (await fs.readFile(passfile, "utf8")).trim();
  const fields = existing.split(":");

  let password;

  if (option.password) {
    password = existing;
  } else {
    password = fields.at(-1);
  }

  require(/^[a-f0-9]{64}$/u.test(password), "CONFIG");

  if (!option.password) {
    require(fields[3] === user, "CONFIG");
  }

  const result = { user, password };

  return result;
}

export async function credentials(record, option) {
  command.root();

  const plan = await prepare(record, option);

  require(plan.replication.length > 0, "CONFIG");

  const peers = [];

  for (const peer of plan.replication) {
    require(peer.user !== "orbitreplica", "CONFIG");

    const filename = path.child(path.home, peer.user + ".pass");
    const present = await store.exists(filename);

    if (present) {
      const registered = store.entry(record, filename);
      const hash = await store.digest(filename);

      require(registered?.hash === hash, "OWNER");
    } else {
      const password = randomBytes(32).toString("hex");

      await primary.write(record, filename, password + "\n");
    }

    const value = { ...peer, password: filename };

    await credential(record, value);

    peers.push(value);
  }

  return peers;
}

export async function join(record, option) {
  command.root();

  require(/^[a-f0-9-]{36}$/u.test(option.id), "AUTHORITY");

  const filename = path.temporary("rejoin-" + option.id + ".pass");
  const login = parseEnv(await fs.readFile(path.administrator, "utf8"));
  const config = parseEnv(await fs.readFile(path.database, "utf8"));

  const columns = [
    config.DB_HOST,
    config.DB_PORT,
    config.DB_NAME,
    login.PGUSER,
    login.PGPASSWORD,
  ];

  const entries = columns.map((value) => {
    const result = String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll(":", "\\:");

    return result;
  });

  const identity = record.identities.orbitdb;

  await fs.writeFile(filename, entries.join(":") + "\n", {
    flag: "wx",
    mode: 0o600,
  });

  try {
    await fs.chown(filename, identity.uid, identity.gid);

    return await joined(record, option, filename);
  } finally {
    await fs.unlink(filename).catch((failure) => {
      if (failure.code !== "ENOENT") {
        throw failure;
      }
    });
  }
}

export async function slots(record, option) {
  command.root();

  const value = await state(option.id);

  require(["promoted", "applied", "complete"].includes(value.stage), "STATE");

  const report = await replica.snapshot(record);

  require(report.recovery === false, "PRIMARY");

  require(Array.isArray(option.peers), "CONFIG");

  require(option.peers.length > 0, "CONFIG");

  const names = new Set();
  const users = new Set();
  const peers = [];

  for (const peer of option.peers) {
    require(internal(peer.host), "NETWORK");

    require(/^orbit_[a-z0-9_]+$/u.test(peer.slot), "SLOT");

    require(!names.has(peer.slot), "SLOT");

    require(!users.has(peer.user), "CONFIG");

    names.add(peer.slot);

    users.add(peer.user);

    const { user, password } = await credential(record, peer);

    require(user !== "orbitreplica", "CONFIG");

    peers.push({ ...peer, user, password });
  }

  record.replication.peers ??= [];

  for (const peer of peers) {
    const { user, password } = peer;

    const registered = record.replication.peers.find((entry) => {
      const host = entry.host === peer.host;
      const name = entry.slot === peer.slot;
      const identity = entry.user === user;
      const matching = host && name && identity;

      return matching;
    });

    const existing = await replica.local(
      record,
      "SELECT to_json(EXISTS(SELECT 1 FROM pg_roles WHERE rolname='" +
        user +
        "'))",
    );

    if (existing) {
      require(Boolean(registered), "OWNER");
    }

    if (!existing) {
      const sql = [
        "SET log_statement='none'; ",
        "SET log_min_duration_statement=-1; ",
        "SET log_min_duration_sample=-1; ",
        "SET log_duration=off; ",
        "SET log_min_error_statement='panic'; CREATE ROLE ",
        user,
        " WITH REPLICATION LOGIN PASSWORD '",
        password,
        "'; SELECT to_json(true);",
      ].join("");

      await replica.local(record, sql);

      if (!registered) {
        record.replication.peers.push({
          host: peer.host,
          slot: peer.slot,
          user,
        });

        await store.write(record);
      }
    }

    const valid = await replica.local(
      record,
      "SELECT to_json(rolreplication AND rolcanlogin) FROM pg_roles WHERE rolname='" +
        user +
        "'",
    );

    require(valid === true, "CONFIG");

    const slot = await replica.local(
      record,
      "SELECT coalesce((SELECT row_to_json(slot) FROM (SELECT " +
        "slot_type,temporary FROM pg_replication_slots WHERE " +
        "slot_name='" +
        peer.slot +
        "') slot),'null'::json)",
    );

    if (slot) {
      require(Boolean(registered), "SLOT");

      require(slot.slot_type === "physical", "SLOT");

      require(slot.temporary === false, "SLOT");
    } else {
      const sql = [
        "SELECT to_json(slot_name) FROM ",
        "pg_create_physical_replication_slot('",
        peer.slot,
        "')",
      ].join("");

      await replica.local(record, sql);
    }

    await store.write(record);
  }
}

export async function redirect(record, option) {
  command.root();

  const descriptor = option.descriptor;
  const value = await state(descriptor.id);

  require(value.stage === "held", "STATE");

  const before = await inspect(record);

  require(promotion.caught(option.source, before), "WAL");

  require(before.cluster === descriptor.cluster, "IDENTITY");

  require(descriptor.timeline > before.timeline, "TIMELINE");

  require(internal(descriptor.host), "NETWORK");

  require(/^orbit_[a-z0-9_]+$/u.test(option.slot), "SLOT");

  const { user, password } = await credential(record, option);
  const config = parseEnv(await fs.readFile(path.replica, "utf8"));

  config.DB_HOST = descriptor.host;
  config.DB_PORT = String(descriptor.port);

  const remote = await replica.query(
    record,
    config,
    "SELECT json_build_object('cluster',(SELECT " +
      "system_identifier::text FROM " +
      "pg_control_system()),'recovery',pg_is_in_recovery()," +
      "'timeline',(SELECT timeline_id FROM " +
      "pg_control_checkpoint()),'history'," +
      "pg_read_file('pg_wal/'||lpad(to_hex((SELECT timeline_id FROM " +
      "pg_control_checkpoint())),8,'0')||'.history'))",
  );

  require(remote.recovery === false, "PRIMARY");

  require(remote.cluster === before.cluster, "IDENTITY");

  require(remote.timeline === descriptor.timeline, "TIMELINE");

  const rows = remote.history.split("\n");

  const ancestor = rows
    .map((line) => line.trim().split(/\s+/u))
    .find((row) => {
      const matches = Number(row[0]) === before.timeline;

      return matches;
    });

  require(Boolean(ancestor), "TIMELINE");

  const fork = promotion.position(ancestor[1]);
  const replayed = promotion.position(before.replayed);

  require(fork >= replayed, "TIMELINE");

  await service.execute("stop", record, { target: "DB" });

  await primary.write(
    record,
    path.passfile,
    [descriptor.host, descriptor.port, "replication", user, password].join(
      ":",
    ) + "\n",
  );

  const identity = record.identities.orbitdb;

  await fs.chown(path.passfile, identity.uid, identity.gid);

  const connection = {
    host: descriptor.host,
    port: descriptor.port,
    user,
    sslmode: "verify-full",
    sslcertmode: "disable",
    sslrootcert: path.certificate("ca", "crt"),
    passfile: path.passfile,
    application_name: option.slot,
    connect_timeout: 5,
  };

  const fields = Object.entries(connection).map(([name, contents]) => {
    const escaped = String(contents)
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'");

    const result = name + "='" + escaped + "'";

    return result;
  });

  const origin = fields.join(" ").replaceAll("'", "''");

  const recovery = [
    "primary_conninfo='" + origin + "'",
    "primary_slot_name='" + option.slot + "'",
    "recovery_target_timeline='latest'",
    "",
  ].join("\n");

  await fs.writeFile(path.child(path.db, "postgresql.auto.conf"), recovery, {
    mode: 0o600,
  });

  await fs.chown(
    path.child(path.db, "postgresql.auto.conf"),
    identity.uid,
    identity.gid,
  );

  value.descriptor = descriptor;
  value.stage = "sealed";

  await save(record, value);

  await apply(record, descriptor);

  await service.execute("start", record, { target: "DB", id: descriptor.id });

  const reference = await replica.query(
    record,
    config,
    "SELECT json_build_object('cluster',(SELECT " +
      "system_identifier::text FROM " +
      "pg_control_system()),'timeline',(SELECT timeline_id FROM " +
      "pg_control_checkpoint()),'recovery',false,'readonly','off'," +
      "'position',pg_current_wal_flush_lsn())",
  );

  const report = await waitstandby(record, reference);

  record.replication.slot = option.slot;
  record.replication.user = user;
  value.stage = "joined";

  await store.write(record);

  await save(record, value);

  return report;
}

async function waitstandby(record, reference) {
  const deadline = Date.now() + 30000;

  do {
    const report = await inspect(record);
    const connected = report.receiver?.status === "streaming";
    const applied = promotion.caught(reference, report);
    const ready = connected && applied;

    if (ready) {
      return report;
    }

    await delay(250);
  } while (Date.now() < deadline);

  throw new Error("PROMOTION_WAL_TIMEOUT: WAL catch-up timed out.");
}

async function joined(record, option, filename) {
  command.root();

  const journal = await state(option.id);

  require(["applied", "joining"].includes(journal.stage), "STATE");

  require(database(record).mode === "replica", "REPLICA");

  if (journal.stage === "joining") {
    const details = await control(record);
    const expected = details.timeline === journal.descriptor.timeline;

    const signal = Boolean(
      await store.exists(path.child(path.db, "standby.signal")),
    );

    const rebuilt = expected && signal;

    if (rebuilt) {
      require(details.cluster === journal.descriptor.cluster, "IDENTITY");

      const contents = await fs.readFile(
        path.child(path.db, "postgresql.auto.conf"),
        "utf8",
      );

      require(contents.includes(journal.descriptor.host), "NETWORK");

      require(contents.includes(option.slot), "SLOT");

      const result = await finish(
        record,
        journal,
        journal.method ?? "pg_rewind",
      );

      return result;
    }
  }

  const credentials = await credential(record, option);
  const evidence = await fenced(record, option.id);

  require(evidence.cluster === journal.descriptor.cluster, "IDENTITY");

  require(/^orbit_[a-z0-9_]+$/u.test(option.slot), "SLOT");

  const remote = await replica.snapshot(record, { remote: true });

  require(remote.cluster === evidence.cluster, "IDENTITY");

  require(remote.recovery === false, "PRIMARY");

  require(remote.timeline === journal.descriptor.timeline, "TIMELINE");

  const config = parseEnv(await fs.readFile(path.database, "utf8"));
  const login = parseEnv(await fs.readFile(path.administrator, "utf8"));

  const env = {
    PGHOST: config.DB_HOST,
    PGPORT: config.DB_PORT,
    PGDATABASE: config.DB_NAME,
    PGUSER: login.PGUSER,
    PGPASSWORD: login.PGPASSWORD,
    PGSSLMODE: "verify-full",
    PGSSLCERTMODE: "disable",
    PGSSLROOTCERT: path.certificate("ca", "crt"),
    PGCONNECT_TIMEOUT: "5",
  };

  const binary = path.child(record.tools.postgres, "pg_rewind");

  const settings = {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dbname: config.DB_NAME,
    user: login.PGUSER,
    passfile: filename,
    sslmode: "verify-full",
    sslcertmode: "disable",
    sslrootcert: path.certificate("ca", "crt"),
    connect_timeout: 5,
  };

  const parameters = Object.entries(settings).map(([name, value]) => {
    const escaped = String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'");

    const result = name + "='" + escaped + "'";

    return result;
  });

  const connection = parameters.join(" ");
  const args = ["--target-pgdata=" + path.db, "--source-server=" + connection];

  const rehearsal = await platform.host.user(
    "orbitdb",
    binary,
    [...args, "--dry-run"],
    { timeout: 120000, allow: true },
  );

  journal.stage = "joining";

  await save(record, journal);

  let method = "pg_rewind";

  if (rehearsal.code === 0) {
    const result = await platform.host.user("orbitdb", binary, args, {
      timeout: 120000,
      allow: true,
    });

    if (result.code !== 0) {
      method = "pg_basebackup";
    }
  } else {
    method = "pg_basebackup";
  }

  if (method === "pg_basebackup") {
    await initialize(record, journal, connection);
  }

  const { user, password } = credentials;

  const sql = [
    "SET log_statement='none';",
    "SET log_min_duration_statement=-1;",
    "SET log_min_duration_sample=-1;",
    "SET log_duration=off;",
    "SET log_min_error_statement='panic';",
    "SELECT pg_create_physical_replication_slot('" +
      option.slot +
      "') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='" +
      option.slot +
      "');",
  ].join("\n");

  await command.run(
    path.child(record.tools.postgres, "psql"),
    ["-X", "-q", "--no-password", "-v", "ON_ERROR_STOP=1"],
    { env, input: sql, timeout: 10000 },
  );

  const pass = [
    config.DB_HOST,
    config.DB_PORT,
    "replication",
    user,
    password,
  ].join(":");

  await primary.write(record, path.passfile, pass + "\n");

  const identity = record.identities.orbitdb;

  await fs.chown(path.passfile, identity.uid, identity.gid);

  const local = {
    DB_HOST: "127.0.0.1",
    DB_PORT: config.DB_PORT,
    DB_NAME: config.DB_NAME,
    DB_USER: login.PGUSER,
    DB_PASSWORD: login.PGPASSWORD,
  };

  const lines = Object.entries(local).map(([name, contents]) => {
    const result = name + "=" + JSON.stringify(contents);

    return result;
  });

  await primary.write(record, path.replica, [...lines, ""].join("\n"));

  const replication = {
    host: config.DB_HOST,
    port: config.DB_PORT,
    user,
    sslmode: "verify-full",
    sslcertmode: "disable",
    sslrootcert: path.certificate("ca", "crt"),
    passfile: path.passfile,
    application_name: option.slot,
    connect_timeout: 5,
  };

  const entries = Object.entries(replication).map(([name, contents]) => {
    const quoted = String(contents).replaceAll("'", "\\'");
    const result = name + "='" + quoted + "'";

    return result;
  });

  const origin = entries.join(" ").replaceAll("'", "''");

  const recovery = [
    "primary_conninfo='" + origin + "'",
    "primary_slot_name='" + option.slot + "'",
    "recovery_target_timeline='latest'",
    "",
  ].join("\n");

  await fs.writeFile(path.child(path.db, "postgresql.auto.conf"), recovery, {
    mode: 0o600,
  });

  await fs.writeFile(path.child(path.db, "standby.signal"), "", {
    mode: 0o600,
  });

  await data.ownership([path.db], {
    uid: identity.uid,
    gid: identity.gid,
    owners: [0, identity.uid],
  });

  record.replication.slot = option.slot;

  await store.write(record);

  journal.method = method;

  await save(record, journal);

  return await finish(record, journal, method);
}

async function finish(record, journal, method) {
  const identity = record.identities.orbitdb;

  await data.stopped(record);

  await primary.remove(record, path.blocked);

  await system.fence(record, database(record), false);

  await service.execute("start", record, { target: "DB", id: journal.id });

  const reference = await replica.snapshot(record, { remote: true });
  const deadline = Date.now() + 30000;

  do {
    const report = await inspect(record);
    const recovering = report.recovery === true;
    const readonly = report.readonly === "on";
    const streaming = report.receiver?.status === "streaming";
    const caught = promotion.caught(reference, report);
    const ready = recovering && readonly && streaming && caught;

    if (ready) {
      journal.stage = "joined";
      journal.method = method;

      await save(record, journal);

      if (journal.previous) {
        const expected = path.adjacent(path.db, ".previous-" + journal.id);

        require(journal.previous === expected, "OWNER");

        await erase(expected, identity);

        delete journal.previous;

        await save(record, journal);
      }

      return report;
    }

    await delay(250);
  } while (Date.now() < deadline);

  throw new Error("PROMOTION_REJOIN: Replica rejoin did not complete.");
}

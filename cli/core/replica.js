import * as fs from "node:fs/promises";
import { parseEnv } from "node:util";
import * as path from "#cli/core/path.js";
import * as store from "#cli/core/manifest.js";
import * as tools from "#cli/core/tools.js";
import * as platform from "#cli/core/platform.js";
import * as command from "#cli/core/process.js";
import * as template from "#cli/core/template.js";
import * as system from "#cli/core/system.js";
import * as instance from "#cli/core/instance.js";
import * as account from "#cli/core/account.js";
import { lock } from "#cli/core/lock.js";
import { internal } from "#cli/network/config.js";
import * as upgrade from "#cli/core/upgrade.js";

function quoted(value) {
  const escaped = String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const result = "'" + escaped + "'";

  return result;
}

async function secret(filename) {
  if (!path.absolute(filename)) {
    throw new Error("REPLICA_CONFIG: Absolute input path required.");
  }

  const details = await fs.lstat(filename);
  const secure = store.secure(details);
  const restricted = !(details.mode & 0o077);
  const valid = secure && restricted;

  if (!valid) {
    throw new Error("REPLICA_CONFIG: Private root-owned input required.");
  }

  return await fs.readFile(filename, "utf8");
}

export async function prepare(record, option) {
  command.root();

  const installed = record?.installed === true;

  if (!installed) {
    throw new Error("REPLICA_CONFIG: Existing Orbit installation required.");
  }

  if (
    record.services.some((service) => {
      return service.role === "DB";
    })
  ) {
    throw new Error("REPLICA_CONFIG: Database service already exists.");
  }

  const integer = Number.isInteger(option.port);
  const positive = option.port > 0;
  const within = option.port <= 65535;
  const port = integer && positive && within;
  const host = internal(option.host);
  const slot = /^orbit_[a-z0-9_]+$/.test(option.slot);
  const user = /^orbit[a-z0-9_]+$/.test(option.user);
  const valid = port && host && slot && user;

  if (!valid) {
    throw new Error("REPLICA_CONFIG: Invalid private replication endpoint.");
  }

  if (!/^\d{10,20}$/.test(option.cluster)) {
    throw new Error("REPLICA_CLUSTER: Expected source cluster required.");
  }

  const settings = await instance.prepare(
    { roles: ["db"], instance: option.instance, tls: option.tls },
    record.tools,
  );

  const authority = await fs.readFile(path.certificate("ca", "crt"), "utf8");

  if (settings.certificates["ca.crt"] !== authority) {
    throw new Error("REPLICA_CONFIG: Existing Orbit CA required.");
  }

  const password = (await secret(option.password)).trim();

  if (!/^[a-f0-9]{64}$/.test(password)) {
    throw new Error("REPLICA_CONFIG: Invalid replication credential.");
  }

  const credentials = await secret(option.credentials);
  const release = await lock("service");

  try {
    if (!(await store.exists(path.file("db", "migrate.js")))) {
      await upgrade.database(record, { source: option.source, migrate: false });
    }

    for (const filename of [
      path.db,
      path.replica,
      path.passfile,
      path.postgres,
      path.authentication,
      path.unit("orbit-db.service"),
    ]) {
      if (await store.exists(filename)) {
        throw new Error(
          "REPLICA_CONFIG: Existing database path must not be replaced.",
        );
      }
    }

    record.stage = "replica";

    await store.write(record);

    await tools.commit(record, option.prepared, { extend: true });

    const binary = record.tools.postgres;

    if (!(await tools.usable(binary, "postgres"))) {
      throw new Error("REPLICA_CONFIG: PostgreSQL 18 required.");
    }

    await account.create(record, "orbitdb");

    const identity = record.identities.orbitdb;

    async function owned(filename, contents, mode) {
      await store.file(record, filename, contents, { mode });

      await fs.chown(filename, identity.uid, identity.gid);
    }

    for (const extension of ["crt", "key"]) {
      const filename = path.certificate("db", extension);

      let mode;

      if (extension === "key") {
        mode = 0o600;
      } else {
        mode = 0o644;
      }

      await owned(filename, settings.certificates["db." + extension], mode);
    }

    const contents = `${option.host}:${option.port}:replication:${option.user}:${password}\n`;

    await owned(path.passfile, contents, 0o600);

    await store.file(record, path.replica, credentials, { mode: 0o600 });

    await store.directory(record, path.db, {
      data: true,
      keep: true,
      mode: 0o700,
    });

    await fs.chown(path.db, identity.uid, identity.gid);

    const connection = {
      host: option.host,
      port: option.port,
      user: option.user,
      sslmode: "verify-full",
      sslcertmode: "disable",
      sslrootcert: path.certificate("ca", "crt"),
      passfile: path.passfile,
      application_name: option.slot,
      connect_timeout: 5,
      keepalives_idle: 5,
      keepalives_interval: 2,
      keepalives_count: 3,
    };

    const entries = Object.entries(connection).map(([name, value]) => {
      const result = name + "=" + quoted(value);

      return result;
    });

    const origin = entries.join(" ");

    const args = [
      "-D",
      path.db,
      "-d",
      origin,
      "-R",
      "-X",
      "stream",
      "--slot=" + option.slot,
      "--checkpoint=fast",
      "--manifest-checksums=SHA256",
      "--no-password",
    ];

    await platform.host.user(
      "orbitdb",
      path.child(binary, "pg_basebackup"),
      args,
      { timeout: 300000 },
    );

    await platform.host.user(
      "orbitdb",
      path.child(binary, "pg_verifybackup"),
      [path.db],
      { timeout: 120000 },
    );

    await fs.access(path.child(path.db, "standby.signal"));

    const lines = [
      "data_directory=" + quoted(path.db),
      "hba_file=" + quoted(path.authentication),
      "ident_file=" + quoted(path.identity),
      "listen_addresses='127.0.0.1'",
      "port=55432",
      "unix_socket_directories=" + quoted(path.socket),
      "hot_standby=on",
      "ssl=on",
      "ssl_cert_file=" + quoted(path.certificate("db", "crt")),
      "ssl_key_file=" + quoted(path.certificate("db", "key")),
      "logging_collector=off",
      "log_destination='stderr'",
      "",
    ];

    await store.file(record, path.postgres, lines.join("\n"));

    const rules = [
      "local all all scram-sha-256",
      "hostssl all all 127.0.0.1/32 scram-sha-256",
      "host all all 0.0.0.0/0 reject",
      "host all all ::0/0 reject",
      "",
    ];

    await store.file(record, path.authentication, rules.join("\n"));

    if (platform.mac) {
      await owned(path.journal("db"), "", 0o600);

      const entry = store.entry(record, path.journal("db"));

      entry.type = "log";
      entry.uid = identity.uid;
    }

    const unit = template.service("db", path.child(binary, "postgres"), {
      node: record.tools.node,
    });

    await store.file(record, path.unit("orbit-db.service"), unit);

    const service = {
      name: "DB" + settings.number,
      role: "DB",
      mode: "replica",
      unit: "orbit-db.service",
      port: 55432,
      address: "127.0.0.1:55432",
    };

    record.services.push(service);

    record.replication = {
      role: "replica",
      host: option.host,
      port: option.port,
      slot: option.slot,
    };

    await store.write(record);

    await system.validate([service]);

    await system.reload([service]);

    const control = await command.run(
      path.child(binary, "pg_controldata"),
      [path.db],
      { env: { LC_ALL: "C" } },
    );

    const cluster = control.output.match(
      /^Database system identifier:\s+(\d+)$/m,
    )?.[1];

    if (cluster !== option.cluster) {
      throw new Error(
        "REPLICA_CLUSTER: Base Backup belongs to another cluster.",
      );
    }

    const metadata = { project: "Orbit", version: 1, cluster };
    const text = JSON.stringify(metadata) + "\n";
    const meta = store.entry(record, path.meta);

    if (meta) {
      if (meta.hash !== (await store.digest(path.meta))) {
        throw new Error("REPLICA_CONFIG: Changed database metadata.");
      }

      const previous = JSON.parse(await fs.readFile(path.meta, "utf8"));

      if (previous.cluster !== null) {
        throw new Error("REPLICA_CONFIG: Existing database metadata.");
      }

      await fs.writeFile(path.meta, text, { mode: 0o600 });

      meta.hash = await store.digest(path.meta);
    } else {
      await store.file(record, path.meta, text, { keep: true, mode: 0o600 });
    }

    record.stage = "installed";

    await store.write(record);
  } finally {
    await release();
  }
}

export async function query(record, config, sql) {
  const env = {
    PGHOST: config.DB_HOST,
    PGPORT: config.DB_PORT,
    PGDATABASE: config.DB_NAME,
    PGUSER: config.DB_USER,
    PGPASSWORD: config.DB_PASSWORD,
    PGSSLMODE: "verify-full",
    PGSSLCERTMODE: "disable",
    PGSSLROOTCERT: path.certificate("ca", "crt"),
    PGCONNECT_TIMEOUT: "3",
    PGOPTIONS: "-c statement_timeout=3000",
  };

  const args = [
    "-X",
    "-q",
    "-A",
    "-t",
    "--no-password",
    "-v",
    "ON_ERROR_STOP=1",
  ];

  const report = await command.run(
    path.child(record.tools.postgres, "psql"),
    args,
    { env, input: sql, timeout: 5000 },
  );

  return JSON.parse(report.output.trim());
}

export async function remote(record, sql) {
  command.root();

  const config = parseEnv(await secret(path.database));
  const login = parseEnv(await secret(path.administrator));

  config.DB_USER = login.PGUSER;
  config.DB_PASSWORD = login.PGPASSWORD;

  return await query(record, config, sql);
}

export async function inspect(record) {
  const text = await secret(path.replica);
  const config = parseEnv(text);

  const sql = [
    "SELECT json_build_object(",
    "'recovery',pg_is_in_recovery(),",
    "'readonly',current_setting('transaction_read_only'),",
    "'received',pg_last_wal_receive_lsn(),",
    "'replayed',pg_last_wal_replay_lsn(),",
    "'lag',pg_wal_lsn_diff(pg_last_wal_receive_lsn(),pg_last_wal_replay_lsn()),",
    "'replay',pg_last_xact_replay_timestamp(),",
    "'receiver',(SELECT row_to_json(receiver) FROM (SELECT " +
      "status,sender_host,sender_port,written_lsn,flushed_lsn," +
      "latest_end_lsn,last_msg_receipt_time FROM " +
      "pg_stat_wal_receiver) receiver))",
  ].join(" ");

  const result = await query(record, config, sql);

  if (!result.recovery) {
    throw new Error("REPLICA_ROLE: Standby is no longer in recovery.");
  }

  return result;
}

export async function local(record, sql) {
  command.root();

  const stored = await store.exists(path.replica);

  let filename;

  if (stored) {
    filename = path.replica;
  } else {
    filename = path.database;
  }

  const config = parseEnv(await secret(filename));

  if (!stored) {
    const login = parseEnv(await secret(path.administrator));

    config.DB_USER = login.PGUSER;
    config.DB_PASSWORD = login.PGPASSWORD;
  }

  config.DB_HOST = "127.0.0.1";

  return await query(record, config, sql);
}

export async function snapshot(record, option = {}) {
  const sql = [
    "SELECT json_build_object(",
    "'cluster',(SELECT system_identifier::text FROM pg_control_system()),",
    "'timeline',CASE WHEN pg_is_in_recovery() THEN " +
      "coalesce((SELECT received_tli FROM " +
      "pg_stat_wal_receiver),(SELECT timeline_id FROM " +
      "pg_control_checkpoint())) ELSE (SELECT timeline_id FROM " +
      "pg_control_checkpoint()) END,",
    "'recovery',pg_is_in_recovery(),",
    "'readonly',current_setting('transaction_read_only'),",
    "'position',CASE WHEN pg_is_in_recovery() THEN NULL ELSE pg_current_wal_flush_lsn() END,",
    "'received',pg_last_wal_receive_lsn(),",
    "'replayed',pg_last_wal_replay_lsn(),",
    "'lag',pg_wal_lsn_diff(pg_last_wal_receive_lsn(),pg_last_wal_replay_lsn()),",
    "'replay',pg_last_xact_replay_timestamp(),",
    "'paused',CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() ELSE false END,",
    "'minimum',(SELECT " +
      "json_build_object('position',min_recovery_end_lsn," +
      "'timeline',min_recovery_end_timeline) FROM " +
      "pg_control_recovery()),",
    "'receiver',(SELECT row_to_json(receiver) FROM (",
    "SELECT status,sender_host,sender_port,received_tli,flushed_lsn,last_msg_receipt_time",
    "FROM pg_stat_wal_receiver) receiver),",
    "'sessions',(SELECT count(*) FROM pg_stat_activity",
    "WHERE backend_type='client backend' AND pid<>pg_backend_pid()),",
    "'prepared',(SELECT count(*) FROM pg_prepared_xacts),",
    "'time',clock_timestamp())",
  ].join(" ");

  const external = option.remote;

  let result;

  if (external) {
    result = await remote(record, sql);
  } else {
    result = await local(record, sql);
  }

  return result;
}

export async function primary(record) {
  const text = await secret(path.database);
  const credentials = await secret(path.administrator);
  const config = parseEnv(text);
  const login = parseEnv(credentials);

  config.DB_USER = login.PGUSER;
  config.DB_PASSWORD = login.PGPASSWORD;

  const sql = [
    "SELECT json_build_object('recovery',pg_is_in_recovery(),'position',pg_current_wal_lsn(),",
    "'senders',(SELECT coalesce(json_agg(sender),'[]'::json) FROM (",
    "SELECT application_name,client_addr,state,sync_state,sent_lsn,write_lsn,flush_lsn,replay_lsn,",
    "pg_wal_lsn_diff(pg_current_wal_lsn(),replay_lsn) AS lag,reply_time,ssl,version",
    "FROM pg_stat_replication JOIN pg_stat_ssl USING(pid)) sender),",
    "'slots',(SELECT coalesce(json_agg(slot),'[]'::json) FROM (",
    "SELECT " +
      "slot_name,slot_type,active,restart_lsn,wal_status," +
      "safe_wal_size FROM pg_replication_slots) slot))",
  ].join(" ");

  const result = await query(record, config, sql);

  if (result.recovery) {
    throw new Error("REPLICA_ROLE: Source is not a Primary.");
  }

  const peers = record.replication?.peers ?? [];
  const names = peers.map((peer) => peer.slot);

  for (const slot of result.slots) {
    const owned = names.includes(slot.slot_name);
    const lost = slot.wal_status === "lost";
    const failed = owned && lost;

    if (failed) {
      throw new Error(
        "REPLICA_WAL: Retained WAL unavailable. Reinitialize the standby.",
      );
    }
  }

  return result;
}

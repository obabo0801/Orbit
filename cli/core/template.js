import * as platform from "#cli/platform/index.js";
import * as mac from "#cli/platform/mac/template.js";
import * as path from "#cli/core/path.js";

export function preserve(contents, previous) {
  if (platform.mac) {
    return mac.preserve(contents, previous);
  }

  return contents;
}

export function observer(executable) {
  if (platform.mac) {
    return mac.observer(executable);
  }

  const lines = [
    "[Unit]",
    "Description=Orbit Monitor",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${executable} ${path.observer}`,
    "Environment=ORBIT_SYSTEM=1",
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE",
    `ReadWritePaths=${path.monitoring} ${path.history}`,
    "UMask=0077",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ];

  return lines.join("\n");
}

export function service(role, executable, option = {}) {
  if (platform.mac) {
    return mac.service(role, executable, option);
  }

  const db = database(executable);
  const was = backend(executable);
  const caddy = proxy(executable);
  const options = { db, was, caddy };
  const settings = options[role];

  const lines = [
    "[Unit]",
    `Description=Orbit ${role}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${settings.user}`,
    `Group=${settings.user}`,
    `ExecStart=${settings.command}`,
    "Restart=on-failure",
    "RestartSec=3",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "UMask=0077",
    "StandardOutput=journal",
    "StandardError=journal",
    settings.extra,
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ];

  return lines.join("\n");
}

function database(executable) {
  const command = `${executable} -D ${path.db} -c config_file=${path.postgres}`;

  const lines = [
    "RuntimeDirectory=orbit/db",
    "RuntimeDirectoryMode=0750",
    "KillSignal=SIGINT",
    "TimeoutStopSec=60",
    `ReadWritePaths=${path.db} ${path.socket}`,
    "",
  ];

  const extra = lines.join("\n");
  const result = { user: "orbitdb", command, extra };

  return result;
}

function backend(executable) {
  const entry = path.file("was", "index.js");
  const command = `${executable} ${entry}`;

  const lines = [
    "Environment=NODE_ENV=production",
    `Environment=WAS_CONFIG=${path.was}`,
    "TimeoutStopSec=15",
    "",
  ];

  const extra = lines.join("\n");
  const result = { user: "orbitwas", command, extra };

  return result;
}

function proxy(executable) {
  const entry = path.file("cli", "ingress.sh");
  const command = `/bin/sh ${entry} ${executable} run --config ${path.caddy.config} --adapter caddyfile`;

  const lines = [
    `Environment=XDG_DATA_HOME=${path.caddy.data}`,
    `Environment=XDG_CONFIG_HOME=${path.caddy.runtime}`,
    "RuntimeDirectory=orbit/caddy",
    "RuntimeDirectoryMode=0750",
    `ReadWritePaths=${path.caddy.data} ${path.caddy.runtime}`,
    "TimeoutStopSec=30",
    "",
  ];

  const extra = lines.join("\n");
  const result = { user: "orbitcaddy", command, extra };

  return result;
}

export function caddy(port, option = {}) {
  const address = option.address ?? "127.0.0.1";
  const addresses = option.addresses ?? [address];

  const sites = addresses.map(function site(value) {
    let hostname;

    if (value === "127.0.0.1") {
      hostname = "localhost";
    } else {
      hostname = value;
    }

    const result = `https://${hostname}:${port}`;

    return result;
  });

  const crt = path.certificate("caddy", "crt");
  const pem = path.certificate("caddy", "key");
  const folder = path.file("web", "dist");

  let certificate;

  if (platform.mac) {
    certificate = JSON.stringify(crt);
  } else {
    certificate = crt;
  }

  let key;

  if (platform.mac) {
    key = JSON.stringify(pem);
  } else {
    key = pem;
  }

  let build;

  if (platform.mac) {
    build = JSON.stringify(folder);
  } else {
    build = folder;
  }

  let logging;

  if (option.redact) {
    logging = [
      "\tlog default {",
      "\t\tformat filter {",
      "\t\t\twrap json",
      "\t\t\tfields {",
      "\t\t\t\trequest>headers delete",
      "\t\t\t\tresp_headers delete",
      "\t\t\t}",
      "\t\t}",
      "\t}",
    ];
  } else {
    logging = [];
  }

  const lines = [
    "{",
    "\tadmin off",
    "\tauto_https off",
    ...logging,
    "}",
    `${sites.join(", ")} {`,
    `\tbind ${addresses.join(" ")}`,
    `\ttls ${certificate} ${key}`,
    `\troot * ${build}`,
    "\tfile_server",
    "\tlog {",
    "\t\toutput stderr",
    "\t}",
    "}",
    "",
  ];

  return lines.join("\n");
}

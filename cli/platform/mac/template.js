import * as path from "#cli/core/path.js";

function escaped(value) {
  const text = String(value);

  const result = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  return result;
}

export function label(unit) {
  const role = unit.slice(6, -8);
  const result = "com.orbit." + role;

  return result;
}

function plist(role, executable, option) {
  const { args, env, node } = option;
  const unit = "orbit-" + role + ".service";
  const name = label(unit);
  const output = path.journal(role);
  const runner = [node, path.supervisor, role, executable, ...args];

  const program = runner.map((value) => {
    const text = "<string>" + escaped(value) + "</string>";

    return text;
  });

  const variables = Object.entries(env).map(([key, value]) => {
    const name = "<key>" + escaped(key) + "</key>";
    const entry = "<string>" + escaped(value) + "</string>";
    const text = name + entry;

    return text;
  });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>Label</key><string>" + name + "</string>",
    "<key>ProgramArguments</key><array>",
    ...program,
    "</array>",
    "<key>EnvironmentVariables</key><dict>",
    ...variables,
    "</dict>",
    "<key>UserName</key><string>root</string>",
    "<key>GroupName</key><string>wheel</string>",
    "<key>RunAtLoad</key><false/>",
    "<key>KeepAlive</key><false/>",
    "<key>ExitTimeOut</key><integer>60</integer>",
    "<key>Umask</key><integer>63</integer>",
    "<key>StandardOutPath</key><string>" + escaped(output) + "</string>",
    "<key>StandardErrorPath</key><string>" + escaped(output) + "</string>",
    "</dict></plist>",
    "",
  ];

  return lines.join("\n");
}

export function service(role, executable, option = {}) {
  const args = {
    db: ["-D", path.db, "-c", "config_file=" + path.postgres],
    was: [path.file("was", "index.js")],
    caddy: [
      path.file("cli", "ingress.sh"),
      executable,
      "run",
      "--config",
      path.caddy.config,
      "--adapter",
      "caddyfile",
    ],
  };

  const environment = {
    db: {},
    was: { NODE_ENV: "production", WAS_CONFIG: path.was },
    caddy: {
      XDG_DATA_HOME: path.caddy.data,
      XDG_CONFIG_HOME: path.caddy.runtime,
    },
  };

  const node = option.node ?? process.execPath;
  const setting = { args: args[role], env: environment[role], node };

  let program;

  if (role === "caddy") {
    program = "/bin/sh";
  } else {
    program = executable;
  }

  return plist(role, program, setting);
}

export function observer(executable) {
  const args = [path.observer];
  const env = { ORBIT_SYSTEM: "1" };
  const setting = { args, env, node: executable };

  return plist("monitor", executable, setting);
}

export function preserve(contents, previous) {
  const enabled = previous?.includes("<key>RunAtLoad</key><true/>") === true;

  let value;

  if (enabled) {
    value = "<true/>";
  } else {
    value = "<false/>";
  }

  const result = contents.replace(
    /<key>RunAtLoad<\/key><(?:true|false)\/>/,
    "<key>RunAtLoad</key>" + value,
  );

  return result;
}

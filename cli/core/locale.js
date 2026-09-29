import * as command from "#cli/core/process.js";

let origin;

export async function native() {
  if (process.platform !== "win32") {
    const result = Intl.DateTimeFormat().resolvedOptions().locale;

    return result;
  }

  const fallback = "en";

  if (origin) {
    return origin;
  }

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$language = Get-WinUILanguageOverride",
    "if ($language) { $language.Name; exit }",
    "Add-Type -TypeDefinition @'",
    "using System.Runtime.InteropServices;",
    "public static class Locale {",
    '  [DllImport("kernel32.dll")]',
    "  public static extern ushort GetUserDefaultUILanguage();",
    "}",
    "'@",
    "$identifier = [int][Locale]::GetUserDefaultUILanguage()",
    "[System.Globalization.CultureInfo]::GetCultureInfo($identifier).Name",
  ];

  const script = lines.join("\n");
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];

  try {
    const report = await command.run("powershell.exe", args);
    const value = report.output.trim();

    if (/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(value)) {
      origin = value;
    } else {
      origin = fallback;
    }
  } catch {
    origin = fallback;
  }

  return origin;
}

export function resolve(settings, option = {}) {
  let language = settings.language;

  if (language === "auto") {
    const platform = option.platform ?? process.platform;
    const native = origin ?? Intl.DateTimeFormat().resolvedOptions().locale;

    let override = process.env.ORBIT_LOCALE;

    if (!override) {
      override = process.env.LC_ALL;
    }

    let accepted;

    if (!override) {
      accepted = process.env.LC_MESSAGES;
    }

    let configured = override || accepted;

    if (!configured) {
      configured = process.env.LANG;
    }

    const linux = configured || native;

    let system;

    if (platform === "win32") {
      system = native;
    } else {
      system = linux;
    }

    if (system.toLowerCase().startsWith("ko")) {
      language = "ko";
    } else {
      language = "en";
    }
  }

  return language;
}

export async function locale(settings) {
  if (settings.language === "auto") {
    await native();
  }

  const language = resolve(settings);
  const module = await import(`#cli/locale/${language}.js`);

  const output = function translate(name) {
    const messages = module.default;
    const direct = messages[name];
    const action = direct ?? messages.action?.[name];
    const result = action ?? messages.result?.[name];
    const value = result ?? name;

    return value;
  };

  return output;
}

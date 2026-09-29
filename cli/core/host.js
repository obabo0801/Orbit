import { Buffer } from "node:buffer";
import * as command from "#cli/core/process.js";

export function registry() {
  const result = [
    "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'",
    "$items = @()",
    "if (Test-Path -LiteralPath $root) {",
    "  $items = @(Get-ChildItem -LiteralPath $root | " +
      "ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath })",
    "}",
  ];

  return result;
}

export async function read(option = {}) {
  const execute = option.command ?? command;
  const program = option.program ?? "powershell.exe";

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    ...registry(),
    "$entries = @($items | ForEach-Object {",
    "  $base = $_.BasePath",
    "  $file = $_.VhdFileName",
    "  if (-not $file) { $file = 'ext4.vhdx' }",
    "  [ordered]@{ id = $_.PSChildName; name = " +
      "$_.DistributionName; version = $_.Version; uid = " +
      "$_.DefaultUid; base = $base; file = $file }",
    "})",
    "$drives = @([System.IO.DriveInfo]::GetDrives() | " +
      "Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' } | " +
      "ForEach-Object {",
    "  [ordered]@{ name = $_.Name.TrimEnd([char]92); free = " +
      "$_.AvailableFreeSpace; total = $_.TotalSize; format = " +
      "$_.DriveFormat }",
    "})",
    "$result = [ordered]@{ entries = $entries; drives = $drives }",
    "$result | ConvertTo-Json -Depth 4 -Compress",
  ];

  const script = lines.join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  const settings = { env: option.env, timeout: 10000 };
  const report = await execute.run(program, args, settings);
  const result = JSON.parse(report.output.trim());

  for (const entry of result.entries) {
    entry.base = entry.base.replace(/^\\\\\?\\/, "");
  }

  return result;
}

export function usable(drive) {
  const named = /^[A-Z]:$/i.test(drive.name);

  let available = Number.isSafeInteger(drive.free);

  if (available) {
    available = drive.free > 0;
  }

  let result = named && available;

  if (result) {
    result = drive.format === "NTFS";
  }

  return result;
}

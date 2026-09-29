import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export function encode(input) {
  const bytes = Buffer.from(input, "utf8");
  const packed = gzipSync(bytes).toString("base64");

  return packed;
}

function quote(value) {
  const text = value.replaceAll("'", "''");
  const quoted = "'" + text + "'";

  return quoted;
}

export function remote(shell, distribution, input) {
  const ascii = typeof input === "string";

  if (!ascii) {
    throw new Error("UPDATE_INPUT: Worker input must be ASCII text.");
  }

  const unicode = [...input].some((character) => {
    const code = character.charCodeAt(0);

    return code > 127;
  });

  if (unicode) {
    throw new Error("UPDATE_INPUT: Worker input must be ASCII text.");
  }

  const length = Buffer.byteLength(input, "ascii");
  const digest = createHash("sha256").update(input, "ascii").digest("hex");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$buffer = New-Object byte[] ${length}`,
    "$stream = [Console]::OpenStandardInput()",
    "$offset = 0",
    "while ($offset -lt $buffer.Length) {",
    "  $count = $stream.Read($buffer, $offset, $buffer.Length - $offset)",
    "  if ($count -eq 0) { throw 'UPDATE_INPUT: Incomplete Worker input.' }",
    "  $offset += $count",
    "}",
    "foreach ($byte in $buffer) { if ($byte -gt 127) { throw " +
      "'UPDATE_INPUT: Worker input must be ASCII text.' } }",
    "$content = [Text.Encoding]::ASCII.GetString($buffer)",
    "$algorithm = [Security.Cryptography.SHA256]::Create()",
    "try { $digest = " +
      "[BitConverter]::ToString($algorithm.ComputeHash($buffer))" +
      ".Replace('-', '').ToLowerInvariant() } finally { " +
      "$algorithm.Dispose() }",
    `if ($digest -ne '${digest}') { throw 'UPDATE_INPUT: Worker input does not match its frame.' }`,
    "$packed = [Convert]::FromBase64String($content)",
    "$memory = New-Object IO.MemoryStream(,$packed)",
    "$gzip = New-Object IO.Compression.GZipStream($memory, [IO.Compression.CompressionMode]::Decompress)",
    "$reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::UTF8)",
    "try { $content = $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $memory.Dispose() }",
    `$content | & wsl.exe --distribution ${quote(distribution)} --user root --exec /bin/sh -c ${quote(shell)}`,
    "exit $LASTEXITCODE",
  ].join("\n");

  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + encoded;
}

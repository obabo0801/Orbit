#!/bin/sh
set -eu
runtime=$1
shift
mode=prepare
if [ "${1:-}" = --probe ]; then mode=probe; shift; fi
target=
if [ "${1:-}" = --target ]; then
  target=$2
  shift 2
  case "$target" in node.*) ;; *) exit 1 ;; esac
  case "$target" in *[!a-zA-Z0-9.-]*|*..*) exit 1 ;; esac
fi
probe="process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
for candidate in "$@" "$(command -v node || true)"; do
  if [ -n "$target" ]; then break; fi
  if [ -x "$candidate" ] && "$candidate" -e "$probe" >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
    exit
  fi
done
if [ "$mode" = probe ]; then exit 1; fi
if [ "$(id -u)" != 0 ]; then
  exec sudo -- /bin/sh "$0" "$runtime" "$@"
fi
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) exit 1 ;;
esac
case "$(uname -s)" in
  Linux) system=linux ;;
  MINGW*|CYGWIN*) exit 1 ;;
  Darwin) system=darwin ;;
  *) exit 1 ;;
esac
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 180 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --timeout=180 -q "$1" -O "$2"
  else
    return 1
  fi
}
test ! -L "$runtime"
umask 077
mkdir -p "$runtime"
if [ -n "$target" ]; then
  work="$runtime/$target"
  mkdir "$work"
else
  work=$(mktemp -d "$runtime/node.XXXXXX")
fi
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
origin=https://nodejs.org/dist/latest-v24.x
fetch "$origin/SHASUMS256.txt" "$work/checksums"
archive=$(awk -v suffix="-$system-$arch.tar.xz" '$2 ~ suffix "$" {print $2}' "$work/checksums")
case "$archive" in
  node-v24.*-linux-*.tar.xz|node-v24.*-darwin-*.tar.xz) ;;
  *) exit 1 ;;
esac
test "$(printf '%s\n' "$archive" | wc -l)" -eq 1
fetch "$origin/$archive" "$work/$archive"
checksum=$(awk -v name="$archive" '$2 == name {print $1}' "$work/checksums")
if [ "$system" = linux ]; then
  printf '%s  %s\n' "$checksum" "$work/$archive" | sha256sum -c - >/dev/null
else
  actual=$(shasum -a 256 "$work/$archive" | awk '{print $1}')
  test "$actual" = "$checksum"
fi
mkdir "$work/tool"
tar -xJf "$work/$archive" -C "$work/tool" --strip-components=1
"$work/tool/bin/node" -e "$probe"
chmod 755 "$work" "$work/tool"
rm -- "$work/$archive" "$work/checksums"
trap - EXIT HUP INT TERM
printf '%s\n' "$work/tool/bin/node"

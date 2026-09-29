#!/bin/sh
set -eu
operation=$1
file=$2
if [ "$operation" = "--probe" ]; then
  [ "$(cat "$file")" = "systemd" ] || exit 1
  /usr/bin/systemctl show --property=Version >/dev/null 2>&1
  exit $?
fi
[ "$operation" = "--prepare" ] || exit 2
[ "$(id -u)" = "0" ] || exit 2
[ ! -L "$file" ] || exit 3
if [ -e "$file" ]; then
  [ -f "$file" ] || exit 3
  [ "$(stat -c %h "$file")" = "1" ] || exit 3
fi
directory=$(dirname -- "$file")
original=$(mktemp "$directory/.orbit-wsl.XXXXXXXX")
prepared=$(mktemp "$directory/.orbit-wsl.XXXXXXXX")
trap 'rm -f -- "$original" "$prepared"' EXIT HUP INT TERM
existing=false
if [ -e "$file" ]; then
  existing=true
  cp -p -- "$file" "$original"
fi
awk '
  function insert() {
    if (boot && !found) print "systemd=true"
  }
  {
    line=$0
    sub(/\r$/, "", line)
    if (line ~ /^[ \t]*\[/) {
      insert()
      boot=(line ~ /^[ \t]*\[boot\][ \t]*([#;].*)?$/)
      if (boot) section=1
      found=0
    }
    if (boot && line ~ /^[ \t]*systemd[ \t]*=/) {
      match(line, /[#;]/)
      comment=RSTART ? " " substr(line, RSTART) : ""
      print "systemd=true" comment
      found=1
    } else print $0
  }
  END {
    insert()
    if (!section) { print "[boot]"; print "systemd=true" }
  }
' "$original" > "$prepared"
if [ "$existing" = "true" ]; then
  cmp -s -- "$file" "$original" || exit 3
  if cmp -s -- "$file" "$prepared"; then exit 0; fi
  chmod --reference="$file" "$prepared"
  chown --reference="$file" "$prepared"
else
  [ ! -e "$file" ] && [ ! -L "$file" ] || exit 3
  chmod 644 "$prepared"
fi
mv -T -- "$prepared" "$file"

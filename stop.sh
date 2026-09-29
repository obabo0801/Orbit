#!/bin/sh
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$directory/cli/index.js" stop "$@"

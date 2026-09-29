#!/bin/sh
set -eu
ORBIT_INGRESS_STARTED=$(date +%s)
export ORBIT_INGRESS_STARTED
exec "$@"

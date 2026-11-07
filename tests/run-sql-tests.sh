#!/usr/bin/env bash
# SQL test suite entry point — see tests/README.md.
#   tests/run-sql-tests.sh            # fresh embedded-postgres rig
#   DATABASE_URL=postgres://… tests/run-sql-tests.sh   # your own server
set -euo pipefail
cd "$(dirname "$0")/.."
exec node tests/run.mjs "$@"

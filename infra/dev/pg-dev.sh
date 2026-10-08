#!/bin/sh
# User-owned PostgreSQL 16 cluster for development and tests. No sudo, no TCP: unix socket only.
# Usage: sh infra/dev/pg-dev.sh start|stop|status|url
# Data dir: $PW_PG_DIR (default: $HOME/.local/share/paper-workspace/pg-dev). Port: $PW_PG_PORT (54329).
# When run as root (CI containers), the cluster runs as the "postgres" OS user under /tmp.
set -eu
PORT="${PW_PG_PORT:-54329}"
BIN="${PW_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$BIN/initdb" ] || { echo "initdb not found; set PW_PG_BIN to your PostgreSQL bin directory" >&2; exit 2; }
if [ "$(id -u)" = "0" ]; then
  DIR="${PW_PG_DIR:-/tmp/pw-pg-dev}"
  AS="runuser -u postgres --"
else
  DIR="${PW_PG_DIR:-$HOME/.local/share/paper-workspace/pg-dev}"
  AS=""
fi
SOCK="$DIR/socket"

init() {
  [ -f "$DIR/data/PG_VERSION" ] && return 0
  mkdir -p "$DIR"
  [ -n "$AS" ] && chown postgres "$DIR"
  $AS "$BIN/initdb" -D "$DIR/data" -U pw -A trust --no-instructions >/dev/null
  $AS mkdir -p "$SOCK"
  # local socket only; trust is acceptable because the socket dir is private to the cluster owner
  printf "listen_addresses = ''\nunix_socket_directories = '%s'\nunix_socket_permissions = 0700\nport = %s\n" "$SOCK" "$PORT" | $AS tee -a "$DIR/data/postgresql.conf" >/dev/null
}

case "${1:-status}" in
  start)
    init
    $AS "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/server.log" -w status >/dev/null 2>&1 || $AS "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/server.log" -w start >/dev/null
    for db in pw_test pw_dev; do
      $AS "$BIN/psql" -h "$SOCK" -p "$PORT" -U pw -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || $AS "$BIN/createdb" -h "$SOCK" -p "$PORT" -U pw "$db"
    done
    echo "export PW_TEST_DATABASE_URL='postgres://pw@localhost:$PORT/pw_test?host=$SOCK'"
    echo "export PW_DATABASE_URL='postgres://pw@localhost:$PORT/pw_dev?host=$SOCK'"
    ;;
  stop) $AS "$BIN/pg_ctl" -D "$DIR/data" -w stop ;;
  status) $AS "$BIN/pg_ctl" -D "$DIR/data" status || true ;;
  url) echo "postgres://pw@localhost:$PORT/pw_test?host=$SOCK" ;;
  *) echo "usage: $0 start|stop|status|url" >&2; exit 2 ;;
esac

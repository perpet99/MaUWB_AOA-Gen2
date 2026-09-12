#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

SERVER_HOST=${SERVER_HOST:-0.0.0.0}
SERVER_PORT=${SERVER_PORT:-8787}
WEB_HOST=${WEB_HOST:-0.0.0.0}
WEB_PORT=${WEB_PORT:-5173}

cleanup() {
    trap - INT TERM EXIT
    [ -z "${SERVER_PID:-}" ] || kill "$SERVER_PID" 2>/dev/null || true
    [ -z "${WEB_PID:-}" ] || kill "$WEB_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Building shared protocol package..."
npm run build -w @mauwb/protocol

echo "Starting API server on ${SERVER_HOST}:${SERVER_PORT}"
HOST="$SERVER_HOST" PORT="$SERVER_PORT" npm run dev -w @mauwb/server &
SERVER_PID=$!

echo "Starting web server on ${WEB_HOST}:${WEB_PORT}"
npm run dev -w @mauwb/web -- --host "$WEB_HOST" --port "$WEB_PORT" &
WEB_PID=$!

echo "Open http://<this-device-ip>:${WEB_PORT}/ from another device."

wait "$SERVER_PID" "$WEB_PID"

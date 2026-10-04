#!/bin/sh
set -eu
curl -fsS http://localhost:${PORT:-3000}/api/health
printf '\n'

#!/bin/sh
set -eu
node --check server.js
node --check future-v20-v25.js
node --check future-v26-v30.js
node --check future-v31-v34.js
printf 'RBS V34 production syntax check: OK\n'

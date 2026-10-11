#!/bin/sh
# One container: the agent API on an internal port, the web app on $PORT proxying /api to it.
set -e
(cd server && node src/main.ts) &
cd web && exec npx next start -p "${PORT:-3000}"

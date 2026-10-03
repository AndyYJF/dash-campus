#!/usr/bin/env bash
set -euo pipefail
exec docker run --rm --init --name dash-campus-campus-bridge --label dash-campus.role=campus-bridge \
  --network host --env-file /etc/dash-campus/campus-bridge.env \
  dash-campus:local npm run legacy:campus-bridge

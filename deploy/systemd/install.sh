#!/usr/bin/env sh
set -eu

project_dir="${AUTO_DOC_INSTALL_DIR:-/opt/auto-doc-mcp}"
unit_source="$project_dir/deploy/systemd/auto-doc-mcp.service"
unit_target="/etc/systemd/system/auto-doc-mcp.service"

if [ ! -f "$project_dir/.env" ]; then
  echo "Missing $project_dir/.env" >&2
  exit 1
fi

if ! grep -Eq '^CLOUDFLARE_TUNNEL_TOKEN=.+$' "$project_dir/.env"; then
  echo "CLOUDFLARE_TUNNEL_TOKEN is missing or empty in $project_dir/.env" >&2
  exit 1
fi

install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable --now auto-doc-mcp.service
systemctl status auto-doc-mcp.service --no-pager

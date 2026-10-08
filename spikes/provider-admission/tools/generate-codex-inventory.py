#!/usr/bin/env python3
"""Regenerate the pinned Codex app-server method inventory (no login, no model call).

Usage:
  CODEX_HOME=$(mktemp -d) HOME=$(mktemp -d) codex app-server generate-json-schema --out <schema_dir>
  python3 -I generate-codex-inventory.py <schema_dir> <codex_version> <out.json>
"""
import hashlib, json, os, sys

schema_dir, version, out = sys.argv[1], sys.argv[2], sys.argv[3]

def methods(name):
    d = json.load(open(os.path.join(schema_dir, name)))
    found = []
    for variant in d.get('oneOf', []):
        m = variant.get('properties', {}).get('method', {})
        found += m.get('enum', []) or ([m['const']] if 'const' in m else [])
    return found

bundles = {f: hashlib.sha256(open(os.path.join(schema_dir, f), 'rb').read()).hexdigest()
           for f in ['codex_app_server_protocol.schemas.json', 'codex_app_server_protocol.v2.schemas.json']}
inventory = {
    'generated_by': 'codex app-server generate-json-schema --out <dir> (CODEX_HOME=isolated empty dir, no login, no model call)',
    'codex_cli_version': version,
    'schema_bundle_sha256': bundles,
    'client_requests': methods('ClientRequest.json'),
    'server_requests': methods('ServerRequest.json'),
    'server_notifications': methods('ServerNotification.json'),
    'client_notifications': methods('ClientNotification.json'),
}
json.dump(inventory, open(out, 'w'), indent=1, ensure_ascii=False)
print(len(inventory['client_requests']), len(inventory['server_requests']), len(inventory['server_notifications']))

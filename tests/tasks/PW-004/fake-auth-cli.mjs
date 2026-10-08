#!/usr/bin/env node
// Fake `claude auth status --json` / `codex app-server` for the auth isolation sentinel.
const mode = process.env.FAKE_AUTH_MODE;
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'leak') console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));
  else if (mode === 'garbage') console.log('not json');
  else console.log(JSON.stringify({ loggedIn: false }));
  process.exit(mode === 'clean' ? 1 : 0);
}
if (args[0] === 'app-server') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: { codexHome: process.env.CODEX_HOME } }));
      if (msg.method === 'account/read') console.log(JSON.stringify({ id: msg.id, result: { account: mode === 'leak' ? { type: 'chatgpt', email: 'x', planType: 'plus' } : null, requiresOpenaiAuth: true } }));
    }
  });
}

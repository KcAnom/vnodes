'use strict';
// Secret filter: filename-boundary only, on by default, allowlists
// example env files, never drops source files by content.
const path = require('node:path');

const ALLOWLIST = new Set(['.env.example', '.env.sample', '.env.template']);
const SECRET_NAMES = new Set(['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'secrets.yaml', 'secrets.yml', 'secrets.json', '.npmrc', '.netrc', '.pgpass',
  'credentials', 'credentials.json', 'service-account.json', '.htpasswd']);
const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk']);
const SECRET_PREFIXES = ['.env.']; // .env.production, .env.local, ...

function isSecretFile(relPath) {
  const base = path.basename(relPath);
  if (ALLOWLIST.has(base)) return false;
  if (SECRET_NAMES.has(base)) return true;
  if (SECRET_EXTS.has(path.extname(base))) return true;
  if (SECRET_PREFIXES.some(p => base.startsWith(p))) return true;
  return false;
}

module.exports = { isSecretFile };

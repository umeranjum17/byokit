// Stands in for cli-proxy-api: answers /v1/models for the config's client key and records what the launch gave it.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const path = process.argv[process.argv.indexOf('--config') + 1];
const config = JSON.parse(readFileSync(path, 'utf8'));
writeFileSync('probe.json', JSON.stringify({
  argv: process.argv.slice(2), umask: process.umask(), env: process.env, cwd: process.cwd(),
  coreLimit: execFileSync('/bin/sh', ['-c', 'ulimit -c']).toString().trim(), configMode: statSync(path).mode & 0o777,
}));
console.log('fake server up'); // lands in the 0600 log file
http.createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${config.access['api-keys'][0]}` && req.url === '/v1/models';
  res.writeHead(ok ? 200 : 401).end('{}');
}).listen(config.server.port, config.server.host);

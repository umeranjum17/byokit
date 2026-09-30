// Test-only egress guard, loaded into every node of the run (the runner, each test file's child process, spawned
// node helpers) via NODE_OPTIONS --require from scripts/test.sh. The suite is offline by contract (AGENTS.md:
// mocks only, no account, no network, no model), and nothing used to enforce it: a backpass caught production
// code attempting the real auth.openai.com revoke from an unstubbed test. This turns any such dial into a loud,
// immediate failure instead of a silent external call, while loopback fake servers and Unix-socket IPC stay
// usable. Node 22/24's --permission does not cover network, so this hook is the portable mechanism.
'use strict';
if (!globalThis.__byokitEgressGuard) {
  globalThis.__byokitEgressGuard = true;
  // Kit children deliberately receive an empty environment. Keep this test-only
  // preload on Node's argument list so clearing NODE_OPTIONS cannot bypass it.
  const childProcess = require('node:child_process');
  for (const method of ['spawn', 'spawnSync']) {
    const original = childProcess[method];
    childProcess[method] = function (file, args, ...rest) {
      if (file === process.execPath || file === 'node') {
        if (Array.isArray(args)) args = ['--require', __filename, ...args];
        else { rest.unshift(args); args = ['--require', __filename]; }
      }
      return original.call(this, file, args, ...rest);
    };
  }

  const loopback = (host) => {
    if (host === undefined || host === '') return true; // node connects to localhost by default
    host = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost')
      || /^127(\.\d{1,3}){3}$/.test(host)
      || host === '::1' || host === '::ffff:127.0.0.1' || host === '::7f00:1';
  };
  const deny = (what, target) => new Error(`byokit tests are offline: ${what} to ${target} is blocked by scripts/test-egress-guard.cjs (use a 127.0.0.1 fake server, e.g. mockOpenAI())`);

  const net = require('node:net');
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const flat = args.flat(); // callers spread argument objects, so the real options can sit one level deep
    const object = flat.find((a) => a !== null && typeof a === 'object');
    if (object ? object.path === undefined : true) { // a path is a Unix socket / named pipe, always local
      const bad = [object?.host, typeof flat[1] === 'string' ? flat[1] : undefined].find((h) => !loopback(h)); // every host-like slot must be loopback: a non-string second arg is the connect listener; the host then defaults to localhost
      if (bad !== undefined) throw deny('an outbound connection', `${bad}:${object?.port ?? flat[0]}`);
    }
    return connect.apply(this, args);
  };

  const dgram = require('node:dgram');
  const dconnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function (...args) {
    const flat = args.flat();
    const address = typeof flat[1] === 'string' ? flat[1] : undefined; // a non-string second arg is the callback; the address then defaults to loopback
    if (!loopback(address)) throw deny('an outbound datagram connection', `${address}:${flat[0]}`);
    return dconnect.apply(this, args);
  };
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (...args) {
    const tail = args.filter((a) => a !== undefined);
    if (typeof tail[tail.length - 1] === 'function') tail.pop(); // callback
    const address = typeof tail[tail.length - 1] === 'string' ? tail[tail.length - 1] : undefined;
    if (address !== undefined && !loopback(address)) throw deny('an outbound datagram', address);
    return send.apply(this, args);
  };
}

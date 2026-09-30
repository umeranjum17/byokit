// Private subprocess entry. Only its parent consumes stdout; failures never emit platform data.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { osKeyring } from './os-keyring.ts';

const require = createRequire(import.meta.url);
const DEST = 'org.freedesktop.secrets';
const SERVICE = 'org.freedesktop.Secret.Service';
const COLLECTION = 'org.freedesktop.Secret.Collection';
const ITEM = 'org.freedesktop.Secret.Item';
const ROOT = '/org/freedesktop/secrets';

try {
  const { service, operation, name, secret } = JSON.parse(readFileSync(0, 'utf8')) as { service: string; operation: string; name: string; secret?: string };
  let result: unknown;
  if (process.platform === 'linux') {
    // Never autolaunch a bus or activate a service, unlock a collection, create a
    // collection or call Prompt. Locked/absent/ambiguous entries fail closed.
    const dbus = require('@homebridge/dbus-native');
    const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${process.getuid!()}/bus`;
    if (!/^unix:path=[^;]+$/.test(address)) throw new Error();
    const bus = dbus.sessionBus({ busAddress: address, authMethods: ['EXTERNAL'] });
    bus.connection.on('error', () => process.exit(1));
    const call = (path: string, iface: string, member: string, signature = '', body: unknown[] = [], destination = DEST): Promise<any> => new Promise((resolve, reject) => {
      bus.invoke({ path, interface: iface, member, signature, body, destination, flags: 2 }, (error: unknown, ...values: unknown[]) => error ? reject(new Error()) : resolve(values.length === 1 ? values[0] : values));
    });
    const owned = await call('/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', [DEST], 'org.freedesktop.DBus');
    if (!owned) throw new Error();
    const collection = await call(ROOT, SERVICE, 'ReadAlias', 's', ['default']);
    if (collection === '/') throw new Error();
    const locked = await call(collection, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [COLLECTION, 'Locked']);
    if (locked[1][0]) throw new Error();
    const attrs = [['service', service], ['username', name]];
    const [unlocked, inaccessible] = await call(ROOT, SERVICE, 'SearchItems', 'a{ss}', [attrs]);
    if (inaccessible.length || unlocked.length > 1) throw new Error();
    if (operation === 'delete') {
      if (!unlocked.length) result = false;
      else { if (await call(unlocked[0], ITEM, 'Delete') !== '/') throw new Error(); result = true; }
    } else if (operation === 'get' && !unlocked.length) result = null;
    else {
      const [, session] = await call(ROOT, SERVICE, 'OpenSession', 'sv', ['plain', ['s', '']]);
      if (operation === 'get') {
        const value = await call(unlocked[0], ITEM, 'GetSecret', 'o', [session]);
        result = Buffer.from(value[2]).toString('utf8');
      } else if (operation === 'set' && typeof secret === 'string') {
        const properties = [
          [`${ITEM}.Label`, ['s', `keyring:${name}@${service}`]],
          [`${ITEM}.Attributes`, ['a{ss}', attrs]],
        ];
        const [, prompt] = await call(collection, COLLECTION, 'CreateItem', 'a{sv}(oayays)b', [properties, [session, Buffer.alloc(0), Buffer.from(secret), 'text/plain; charset=utf-8'], true]);
        if (prompt !== '/') throw new Error();
        result = null;
      } else throw new Error();
    }
    bus.connection.stream.end();
  } else {
    const ring = osKeyring({ service });
    if (operation === 'get') result = ring.get(name);
    else if (operation === 'set' && typeof secret === 'string') { ring.set(name, secret); result = null; }
    else if (operation === 'delete') result = ring.delete(name);
    else throw new Error();
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
} catch { process.exit(1); }

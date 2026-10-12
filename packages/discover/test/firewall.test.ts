// firewall(): stubbed firewall output per platform, read the way setup would read it before printing its tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firewall, type FirewallRun } from '../src/firewall.ts';

const ok = (stdout: string): FirewallRun => ({ code: 0, stdout, stderr: '' });
const gone = (bin: string): FirewallRun => ({ code: null, stdout: '', stderr: `${bin}: ENOENT command not found` });
const refused = (stderr: string): FirewallRun => ({ code: 1, stdout: '', stderr });
const stub = (outputs: Record<string, FirewallRun>, platform: NodeJS.Platform) => ({
  platform,
  run: async (bin: string, args: string[]) => outputs[`${bin} ${args.join(' ')}`] ?? gone(bin),
});

test('linux ufw off means clear; a deny rule means blocked', async () => {
  const off = await firewall({ port: 8792, ...stub({ 'ufw status': ok('Status: inactive\n') }, 'linux') });
  assert.equal(off.blocked, false);
  const deny = await firewall({
    port: 8792, ...stub({
      'ufw status': ok('Status: active\n\nTo                         Action      From\n--                         ------      ----\n8792/tcp                   DENY IN     Anywhere\n'),
    }, 'linux'),
  });
  assert.equal(deny.blocked, true);
  assert.match(deny.nextStep, /8792/);
  assert.doesNotMatch(deny.nextStep, /sudo/i);
});

test('linux ufw allow rule means clear; active with no rule for the port is unknown', async () => {
  const allow = await firewall({
    port: 8792, ...stub({
      'ufw status': ok('Status: active\n8792/tcp                   ALLOW IN    Anywhere\n22/tcp                     DENY IN     Anywhere\n'),
    }, 'linux'),
  });
  assert.equal(allow.blocked, false);
  const silent = await firewall({
    port: 8792, ...stub({ 'ufw status': ok('Status: active\n22/tcp                     ALLOW IN    Anywhere\n') }, 'linux'),
  });
  assert.equal(silent.blocked, 'unknown');
});

test('linux falls from missing ufw to nftables, then iptables, then honest unknown', async () => {
  const drop = await firewall({
    port: 8792, ...stub({
      'ufw status': gone('ufw'),
      'nft list ruleset': ok('chain input { tcp dport 8792 drop }\n'),
    }, 'linux'),
  });
  assert.equal(drop.blocked, true);
  const accept = await firewall({
    port: 8792, ...stub({
      'ufw status': gone('ufw'),
      'nft list ruleset': ok('chain input { tcp dport 22 accept }\n'),
    }, 'linux'),
  });
  assert.equal(accept.blocked, 'unknown');
  const ipt = await firewall({
    port: 8792, ...stub({
      'ufw status': gone('ufw'),
      'nft list ruleset': gone('nft'),
      'iptables -S': ok('-P INPUT DROP\n-A INPUT -p tcp -m tcp --dport 8792 -j DROP\n'),
    }, 'linux'),
  });
  assert.equal(ipt.blocked, true);
  const locked = await firewall({
    port: 8792, ...stub({
      'ufw status': refused('ERROR: You need to be root to run this script'),
      'nft list ruleset': refused('Operation not permitted (you must be root)'),
      'iptables -S': refused('Permission denied (you must be root)'),
    }, 'linux'),
  });
  assert.equal(locked.blocked, 'unknown');
  assert.match(locked.how, /administrator/);
});

test('macOS off is clear, block-all is blocked, otherwise per-app unknown', async () => {
  const sofw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  const off = await firewall({
    port: 8792, ...stub({ [`${sofw} --getglobalstate`]: ok('Firewall is disabled. (State = 0)') }, 'darwin'),
  });
  assert.equal(off.blocked, false);
  const all = await firewall({
    port: 8792, ...stub({
      [`${sofw} --getglobalstate`]: ok('Firewall is enabled. (State = 1)'),
      [`${sofw} --getblockall`]: ok('Block all incoming connections ENABLED'),
    }, 'darwin'),
  });
  assert.equal(all.blocked, true);
  const perApp = await firewall({
    port: 8792, ...stub({
      [`${sofw} --getglobalstate`]: ok('Firewall is enabled. (State = 1)'),
      [`${sofw} --getblockall`]: ok('Block all incoming connections DISABLED'),
    }, 'darwin'),
  });
  assert.equal(perApp.blocked, 'unknown');
  assert.match(perApp.nextStep, /System Settings/);
});

test('windows off everywhere is clear; an enabled inbound block rule is blocked', async () => {
  const off = await firewall({
    port: 8792, ...stub({
      'netsh advfirewall show allprofiles state': ok('Domain Profile Settings:\nState OFF\nPrivate Profile Settings:\nState OFF\nPublic Profile Settings:\nState OFF\n'),
    }, 'win32'),
  });
  assert.equal(off.blocked, false);
  const blocked = await firewall({
    port: 8792, ...stub({
      'netsh advfirewall show allprofiles state': ok('Public Profile Settings:\nState ON\n'),
      'netsh advfirewall firewall show rule name=all dir=in': ok('Rule Name: block app\nEnabled: Yes\nDirection: In\nAction: Block\nLocalPort: 8792\n\nRule Name: other\nEnabled: No\nDirection: In\nAction: Block\nLocalPort: Any\n'),
    }, 'win32'),
  });
  assert.equal(blocked.blocked, true);
  const vague = await firewall({
    port: 8792, ...stub({
      'netsh advfirewall show allprofiles state': ok('Public Profile Settings:\nState ON\n'),
      'netsh advfirewall firewall show rule name=all dir=in': ok('Rule Name: web\nEnabled: Yes\nDirection: In\nAction: Allow\nLocalPort: 8792\n'),
    }, 'win32'),
  });
  assert.equal(vague.blocked, 'unknown');
});

test('bad ports throw; unrecognized platforms are unknown', async () => {
  await assert.rejects(() => firewall({ port: 0 }), /port must be 1-65535/);
  await assert.rejects(() => firewall({ port: 70000 }), /port must be 1-65535/);
  const other = await firewall({ port: 8792, platform: 'freebsd', run: async () => { throw new Error('must not run'); } });
  assert.equal(other.blocked, 'unknown');
});

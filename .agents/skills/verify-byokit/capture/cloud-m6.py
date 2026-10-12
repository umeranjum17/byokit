#!/usr/bin/env python3
"""Explicit, one-shot physical M6 journey. Call under the device/heavy locks; no sign-in or retries."""
import json, os, re, signal, subprocess as sp, sys, time, xml.etree.ElementTree as ET
from pathlib import Path
serial, apk, evidence, keyfile = sys.argv[1:]
assert serial == 'a4b93ea2', 'Only the approved physical lab phone'
out = Path(evidence); out.mkdir(parents=True, exist_ok=True)
app = 'io.github.umeranjum17.byokit.example'
def adb(*args, data=None):
    return sp.run(['adb', '-s', serial, *args], input=data, stdout=sp.PIPE, stderr=sp.PIPE, check=True, timeout=40).stdout

def ui():
    assert app in adb('shell', 'dumpsys window | grep -m1 mCurrentFocus').decode(), 'Approved lab app is not focused'
    raw = adb('shell', 'uiautomator dump /sdcard/byokit-m6-ui.xml >/dev/null && cat /sdcard/byokit-m6-ui.xml').decode()  # some phones print nothing to /dev/tty
    root = ET.fromstring(raw[raw.index('<hierarchy'):raw.index('</hierarchy>') + 12])
    assert all(n.get('package') in (app, 'com.android.systemui', '') for n in root.iter('node')), 'Lab app is not the foreground UI'
    return list(root.iter('node'))
def wait(words, seconds=90):
    end = time.monotonic() + seconds
    seen = 'nothing'
    while time.monotonic() < end:
        try: nodes = ui()
        except AssertionError as e: seen = str(e); time.sleep(1); continue  # app still coming to the front
        if any(words in n.get('text', '') for n in nodes): return nodes
        seen = ' | '.join(n.get('text') for n in nodes if n.get('text'))[-600:]; time.sleep(1)  # the lab screen's own words, never a key (the app redacts it)
    raise RuntimeError(f'Expected lab state not reached: {words} (last: {seen})')
def tap(name):
    for _ in range(4):
        for n in ui():
            if n.get('resource-id') == name and n.get('enabled') == 'true':
                x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds', '')))
                if y2 > y1 > 0: adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)); return
        adb('shell', 'input', 'swipe', '500', '1500', '500', '650', '300')
    raise RuntimeError('Lab button unavailable: ' + name)
def mark(step): record.setdefault('steps', {})[step] = round(time.time() - record['setup_start'], 1)  # seconds since setup start
def shot(name): (out / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # a lock timeout still runs the cleanup below
record = {'device': serial, 'setup_start': time.time(), 'human_steps': ['Main unlock (PIN not observed)'], 'qualified': False}
video = None; video_pid = None; secret = None; opened = False
try:
    adb('install', '-r', apk)
    adb('shell', 'am', 'start', '-W', '-n', app + '/.MainActivity'); opened = True
    wait('No lab key.'); shot('missing-key')
    record['signins'] = next(n.get('text') for n in ui() if n.get('resource-id') == 'm6-signins')
    if not any('Existing Claude sign-in available.' in n.get('text', '') for n in ui()):
        raise RuntimeError('Existing phone-local Claude sign-in unavailable; ask Main, do not sign in')
    mark('signin_checked')
    secret = Path(keyfile).read_bytes().strip()
    record['key_imported'] = True; (out / 'manifest.tmp').write_text(json.dumps(record)); (out / 'manifest.tmp').replace(out / 'manifest.json')
    adb('shell', 'content', 'write', '--uri', 'content://' + app + '.m6/key', data=secret)
    wait('Lab key ready.'); mark('key_ready'); shot('ready')
    mark('create_tapped'); tap('m6-create'); nodes = wait('Cloud computer created.', 360); mark('created')
    record['machine'] = next(n.get('text')[9:] for n in nodes if n.get('resource-id') == 'm6-resource'); (out / 'manifest.tmp').write_text(json.dumps(record)); (out / 'manifest.tmp').replace(out / 'manifest.json'); shot('created')
    tap('m6-install'); wait('Host installed and running.', 900); mark('ready_installed'); shot('installed')
    remote = '/sdcard/byokit-m6-recording.mp4'
    video = sp.Popen(['adb', '-s', serial, 'shell', f'screenrecord --time-limit 180 {remote} >/dev/null 2>&1 & echo $!; wait $!'], stdout=sp.PIPE, stderr=sp.DEVNULL)
    video_pid = int(video.stdout.readline().strip())
    tap('m6-pair'); wait("Paired with Umer's cloud computer."); mark('paired'); record['setup_end'] = time.time(); shot('paired')
    mark('turn_tapped'); tap('m6-turn'); wait('One paired agent turn completed.', 120); mark('first_turn'); shot('turn')
    mark('stop_tapped'); tap('m6-stop'); wait('Cloud computer stopped and removed. Lab key removed.', 360); mark('stopped'); shot('stopped')
    record['qualified'] = True; record['key_removed'] = True
finally:
    try:
        try:
            if record.get('machine') and not record['qualified']: tap('m6-stop'); wait('Cloud computer stopped and removed.', 360)
        finally:
            if secret: adb('shell', 'content', 'write', '--uri', 'content://' + app + '.m6/key', data=b''); wait('No lab key stored.'); record['key_removed'] = True
    finally:
        if video and video.poll() is None:
            adb('shell', 'kill', '-INT', str(video_pid)); video.wait(timeout=20)
        if video:
            try: adb('pull', '/sdcard/byokit-m6-recording.mp4', str(out / 'journey.mp4')); sp.run(['ffprobe', '-v', 'error', str(out / 'journey.mp4')], check=True)
            except sp.CalledProcessError: record['recording'] = 'none: screenrecord produced no file on this phone'
        if not record['qualified']:  # the lab's safe diagnostic line (call, HTTP status, kind, reason), never a message body
            try: record['diagnostic'] = [l.split('M6 diagnostic ', 1)[1] for l in adb('logcat', '-d', '-v', 'brief', 'ReactNativeJS:W', '*:S').decode(errors='replace').splitlines() if 'M6 diagnostic ' in l][-5:]
            except sp.SubprocessError: record['diagnostic'] = 'logcat unavailable'
        if opened: adb('shell', 'am', 'force-stop', app); adb('shell', 'rm', '-f', '/sdcard/byokit-m6-ui.xml')
        record['skips'] = ['before: new lab-only route absent on base', 'desktop/web: native-only lab', 'dark: fixed light lab screen']
        record['setup_seconds'] = record.get('setup_end', time.time()) - record['setup_start']
        (out / 'manifest.tmp').write_text(json.dumps(record, indent=2)); (out / 'manifest.tmp').replace(out / 'manifest.json')
        if secret: assert not any(secret in p.read_bytes() for p in out.iterdir() if p.is_file()), 'Credential leak in evidence'

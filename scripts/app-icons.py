#!/usr/bin/env python3
"""Generate example icons + actual-size proof from docs/brand (rsvg-convert, ImageMagick 7)."""
import base64, json, math, shutil, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / 'docs/brand'
INK = '#1b1b1a'
images = []
def run(*args):
    subprocess.run([str(a) for a in args], check=True)
def png(master, target, size, opaque=False):
    target = ROOT / target
    target.parent.mkdir(parents=True, exist_ok=True)
    run('rsvg-convert', '-w', size, '-h', size, '-o', target, BRAND / master)
    if opaque:
        run('magick', target, '-background', INK, '-alpha', 'remove', '-alpha', 'off', '-strip', 'PNG24:' + str(target))
    images.append((str(target.relative_to(ROOT)), size))
    return target

def web(directory, title):
    d = ROOT / directory
    shutil.copyfile(BRAND / 'icon.svg', d / 'favicon.svg')
    files = [('favicon-16.png',16), ('favicon-32.png',32), ('apple-touch-icon.png',180), ('icon-192.png',192), ('icon-512.png',512), ('icon.png',1024)]
    for name, size in files: png('icon.svg', f'{directory}/{name}',size,True)
    png('foreground.svg',f'{directory}/icon-maskable-512.png',512)
    p = d / 'icon-maskable-512.png'
    run('magick', p, '-background', INK, '-alpha', 'remove', '-alpha', 'off', '-strip', 'PNG24:' + str(p))
    run('magick', d/'favicon-16.png', d/'favicon-32.png', d/'favicon.ico')
    manifest = dict(name=title, short_name='byokit', start_url='./', display='standalone', background_color=INK, theme_color=INK,
        icons=[dict(src=f'icon-{n}.png',sizes=f'{n}x{n}',type='image/png',purpose='any') for n in (192,512)] + [dict(src='icon-maskable-512.png',sizes='512x512',type='image/png',purpose='maskable')])
    (d/'manifest.webmanifest').write_text(json.dumps(manifest,indent=2)+'\n')

for d, title in [('examples/pwa','byokit example'),('examples/herdr-kit/web','byokit Agents'),('examples/openclaw-kit/web','byokit Helper')]: web(d,title)
A = 'examples/expo/assets'
for master,name in [('icon.svg','icon.png'),('foreground.svg','android-icon-foreground.png'),('monochrome.svg','android-icon-monochrome.png'),('foreground.svg','splash-icon.png')]: png(master,f'{A}/{name}',1024,master=='icon.svg')
png('icon.svg',f'{A}/favicon.png',48,True)
png('icon.svg',f'{A}/store/google-play-512.png',512,True)
run('magick','-size','1024x1024',f'xc:{INK}', '-strip', ROOT/A/'android-icon-background.png')
images.append((f'{A}/android-icon-background.png',1024))
# Expo prebuild owns native projects; the config plugin copies these reproducible resources into them.
for density, factor in [('ldpi',.75),('mdpi',1),('tvdpi',4/3),('hdpi',1.5),('xhdpi',2),('xxhdpi',3),('xxxhdpi',4)]:
    res=f'{A}/android'
    png('icon.svg',f'{res}/mipmap-{density}/ic_launcher.png',int(48*factor),True)
    png('icon.svg',f'{res}/mipmap-{density}/ic_launcher_round.png',int(48*factor),True)
    for master,name in [('foreground.svg','ic_launcher_foreground'),('monochrome.svg','ic_launcher_monochrome')]:
        png(master,f'{res}/drawable-{density}/{name}.png',int(108*factor))
    p=png('monochrome.svg',f'{res}/drawable-{density}/byokit_notification.png',int(24*factor))
    # Notification artwork fills the small-icon viewport, with a one-dp gutter.
    run('magick',p,'-trim','+repage','-resize',f'{int(22*factor)}x{int(22*factor)}','-gravity','center','-background','none','-extent',f'{int(24*factor)}x{int(24*factor)}','-strip',p)
for api,mono in [('v26',''),('v33','<monochrome android:drawable="@drawable/ic_launcher_monochrome"/>')]:
    d=ROOT/A/'android'/f'mipmap-anydpi-{api}'
    d.mkdir(parents=True,exist_ok=True)
    for name in ['ic_launcher','ic_launcher_round']:
        (d/f'{name}.xml').write_text(f'<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/byokit_icon_background"/><foreground android:drawable="@drawable/ic_launcher_foreground"/>{mono}</adaptive-icon>\n')
d=ROOT/A/'android/values';d.mkdir(exist_ok=True)
(d/'byokit_icon.xml').write_text(f'<resources><color name="byokit_icon_background">{INK}</color></resources>\n')
# Full iPhone/iPad + App Store set (all RGB, including 1024 marketing).
entries=[]
for idiom, sizes in [('iphone',[(20,[2,3]),(29,[2,3]),(40,[2,3]),(60,[2,3])]),('ipad',[(20,[1,2]),(29,[1,2]),(40,[1,2]),(76,[1,2]),(83.5,[2])]),('ios-marketing',[(1024,[1])])]:
    for size, scales in sizes:
        for scale in scales:
            filename=f'{idiom}-{size:g}@{scale}x.png'
            png('icon.svg',f'{A}/AppIcon.appiconset/{filename}',int(size*scale),True)
            entries.append(dict(idiom=idiom,size=f'{size:g}x{size:g}',scale=f'{scale}x',filename=filename))
(ROOT/A/'AppIcon.appiconset/Contents.json').write_text(json.dumps(dict(images=entries,info=dict(version=1,author='xcode')),indent=2)+'\n')
# Contact sheet: every generated raster appears at its actual pixel dimensions (no rescaling).
W=2800; rows=[]; x=24;y=70; height=0
for path,n in images:
    if x+n+24>W: x=24;y+=height+64;height=0
    uri='data:image/png;base64,'+base64.b64encode((ROOT/path).read_bytes()).decode()
    rows.append(f'<image x="{x}" y="{y}" width="{n}" height="{n}" href="{uri}"/><text x="{x}" y="{y+n+18}" font-size="11" fill="#1b1b1a">{path} ({n}px)</text>')
    x+=max(n,360)+24;height=max(height,n)
y+=height+90
# Mask previews use actual adaptive layer framing, which differs from the ordinary icon.
def squircle(n):
    pts=[]
    for i in range(128):
        t=2*math.pi*i/128;c=math.cos(t);s=math.sin(t)
        pts.append(f'{n/2+n/2*math.copysign(abs(c)**.4,c):.2f},{n/2+n/2*math.copysign(abs(s)**.4,s):.2f}')
    return 'M'+'L'.join(pts)+'Z'
for j,(master,label,n) in enumerate([('foreground.png','Android adaptive',192),('monochrome.png','Android themed',192),('maskable-512.png','PWA maskable',512)]):
    uri='data:image/png;base64,'+base64.b64encode((BRAND/master).read_bytes()).decode()
    for k,shape in enumerate([f'<circle cx="{n/2}" cy="{n/2}" r="{n/2}"/>',f'<path d="{squircle(n)}"/>']):
        x=24+j*760+k*(n+32)
        # Android launcher crops the 108dp layer to the central 72dp viewport.
        side=n*1.5 if j<2 else n;offset=(n-side)/2
        rows.append(f'<defs><clipPath id="m{j}{k}">{shape}</clipPath></defs><g transform="translate({x} {y})"><g clip-path="url(#m{j}{k})"><rect width="{n}" height="{n}" fill="{INK}"/><image x="{offset}" y="{offset}" width="{side}" height="{side}" href="{uri}"/></g><text y="{n+24}" font-size="16">{label}: {"circle" if k==0 else "squircle"}</text></g>')
out=ROOT/'proof/icons';out.mkdir(parents=True,exist_ok=True)
sheet=out/'contact-sheet.svg'
sheet.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{y+560}"><rect width="100%" height="100%" fill="#e7e6e3"/><text x="24" y="36" font-size="24">BYOKit example icons — actual pixels (view at 100%)</text>'+''.join(rows)+'</svg>')
run('rsvg-convert','-o',out/'contact-sheet.png',sheet)
sheet.unlink()
print(f'Generated {len(images)} raster surfaces and mask previews.')

#!/usr/bin/env python3
"""Regenerates every file in docs/brand from the mark geometry below.

Needs rsvg-convert (librsvg) and ImageMagick 7 (`magick`). Run from anywhere: python3 docs/brand/build.py
"""
import base64, math, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
INK, PAPER, ACCENT = '#1b1b1a', '#f6f5f2', '#1f5eff'

# The mark on a 24-unit grid: a lowercase b (stem and bowl) with the accent dot of a device that is on.
STEM = (3.25, 3.25, 4.5, 18)  # x, y, width, height; ends fully rounded
BOWL = (11.75, 14.75, 6.5, 2)  # cx, cy, outer radius, inner radius
DOT = (18.25, 5.25, 2.5)  # cx, cy, r


def shapes(body, dot):
    x, y, w, h = STEM
    cx, cy, ro, ri = BOWL
    ring = (f'M{cx - ro} {cy}a{ro} {ro} 0 1 0 {2 * ro} 0a{ro} {ro} 0 1 0 {-2 * ro} 0z'
            f'M{cx - ri} {cy}a{ri} {ri} 0 1 0 {2 * ri} 0a{ri} {ri} 0 1 0 {-2 * ri} 0z')
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{w / 2}" fill="{body}"/>'
            f'<path d="{ring}" fill-rule="evenodd" fill="{body}"/>'
            f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{DOT[2]}" fill="{dot}"/>')


def extent():
    """Furthest distance of the mark from the grid centre (12, 12), for the safe-zone check."""
    x, y, w, h = STEM
    r = w / 2
    far = max(math.hypot(px - 12, py - 12) + r for px, py in [(x + r, y + r), (x + r, y + h - r)])
    far = max(far, math.hypot(BOWL[0] - 12, BOWL[1] - 12) + BOWL[2])
    return max(far, math.hypot(DOT[0] - 12, DOT[1] - 12) + DOT[2])


def svg(size, content, bg=None):
    rect = f'<rect width="{size}" height="{size}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">{rect}{content}</svg>\n'


def placed(size, frac, body, dot):
    """The mark scaled so its 24-unit grid spans `frac` of a `size` canvas, centred."""
    s = size * frac / 24
    o = (size - 24 * s) / 2
    return f'<g transform="translate({o:g} {o:g}) scale({s:g})">{shapes(body, dot)}</g>'


def write(name, text):
    with open(os.path.join(HERE, name), 'w') as f:
        f.write(text)


def png(src, out, size, opaque=False):
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), '-o', os.path.join(HERE, out), os.path.join(HERE, src)], check=True)
    if opaque:  # app stores reject alpha on the icon master
        p = os.path.join(HERE, out)
        subprocess.run(['magick', p, '-background', INK, '-alpha', 'remove', '-alpha', 'off', '-strip', 'PNG24:' + p], check=True)


# Icon: 72% grid on the ink square. Foreground/monochrome: grid scaled so the whole mark sits inside the
# adaptive-icon safe circle (66 of 108 dp, radius 30.6% of the canvas); maskable uses the same fit (its
# safe zone, radius 40%, is larger).
ICON_FRAC = 0.72
SAFE_R = 33 / 108  # safe circle radius as a fraction of the canvas
FG_FRAC = SAFE_R * 24 / extent() * 0.96  # 4% breathing room inside the safe circle

write('mark.svg', f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">{shapes(INK, ACCENT)}</svg>\n')
write('icon.svg', svg(1024, placed(1024, ICON_FRAC, PAPER, ACCENT), INK))
write('foreground.svg', svg(1024, placed(1024, FG_FRAC, PAPER, ACCENT)))
write('monochrome.svg', svg(1024, placed(1024, FG_FRAC, '#ffffff', '#ffffff')))
write('maskable.svg', svg(512, placed(512, FG_FRAC, PAPER, ACCENT), INK))

png('icon.svg', 'icon-1024.png', 1024, opaque=True)
png('foreground.svg', 'foreground.png', 1024)
png('monochrome.svg', 'monochrome.png', 1024)
png('maskable.svg', 'maskable-512.png', 512, opaque=True)
os.remove(os.path.join(HERE, 'maskable.svg'))


# Preview sheet: real downscaled PNGs at each size, then the icon under three launcher masks, on light and dark.
def squircle(cx, cy, r, n=5, steps=96):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append(f'{cx + r * math.copysign(abs(c) ** (2 / n), c):.2f},{cy + r * math.copysign(abs(s) ** (2 / n), s):.2f}')
    return 'M' + 'L'.join(pts) + 'Z'


tmp = os.path.join(HERE, '.preview')
os.makedirs(tmp, exist_ok=True)
sizes = [16, 32, 48, 192, 512]
uri = {}
for n in sizes:
    p = os.path.join(tmp, f'{n}.png')
    subprocess.run(['rsvg-convert', '-w', str(n), '-h', str(n), '-o', p, os.path.join(HERE, 'icon.svg')], check=True)
    uri[n] = 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
mono = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(HERE, 'monochrome.png'), 'rb').read()).decode()

W, PAD, M = 1400, 40, 192
rows, y = [], 0
defs = []
for theme, bg, fg in (('light', PAPER, INK), ('dark', '#0e0e0d', PAPER)):
    h = 930
    rows.append(f'<rect y="{y}" width="{W}" height="{h}" fill="{bg}"/>')
    rows.append(f'<text x="{PAD}" y="{y + 50}" fill="{fg}" font-family="sans-serif" font-size="24" font-weight="700">byokit icon · {theme}</text>')
    x = PAD
    base = y + 90 + 512
    for n in sizes:  # actual pixels, bottom-aligned
        rows.append(f'<image x="{x}" y="{base - n}" width="{n}" height="{n}" href="{uri[n]}"/>')
        rows.append(f'<text x="{x}" y="{base + 30}" fill="{fg}" font-family="sans-serif" font-size="16">{n}px</text>')
        x += n + 56
    my = base + 70
    masks = [('circle', f'<circle cx="{M / 2}" cy="{M / 2}" r="{M / 2}"/>'),
             ('squircle', f'<path d="{squircle(M / 2, M / 2, M / 2)}"/>'),
             ('rounded square', f'<rect width="{M}" height="{M}" rx="{M * 0.225}"/>')]
    x = PAD
    for i, (label, shape) in enumerate(masks):
        cid = f'{theme}{i}'
        defs.append(f'<clipPath id="{cid}">{shape}</clipPath>')
        rows.append(f'<g transform="translate({x} {my})"><image width="{M}" height="{M}" href="{uri[512]}" clip-path="url(#{cid})"/></g>')
        rows.append(f'<text x="{x}" y="{my + M + 30}" fill="{fg}" font-family="sans-serif" font-size="16">{label}</text>')
        x += M + 56
    # Android themed icon: the monochrome layer tinted, inside a circle.
    defs.append(f'<clipPath id="{theme}m"><circle cx="{M / 2}" cy="{M / 2}" r="{M / 2}"/></clipPath>')
    tint_bg, tint = ('#dfe6ff', '#1a3a99') if theme == 'light' else ('#1a2b5c', '#c9d6ff')
    defs.append(f'<mask id="{theme}mono"><image width="{M}" height="{M}" href="{mono}"/></mask>')
    rows.append(f'<g transform="translate({x} {my})" clip-path="url(#{theme}m)"><rect width="{M}" height="{M}" fill="{tint_bg}"/>'
                f'<rect width="{M}" height="{M}" fill="{tint}" mask="url(#{theme}mono)"/></g>')
    rows.append(f'<text x="{x}" y="{my + M + 30}" fill="{fg}" font-family="sans-serif" font-size="16">themed (monochrome)</text>')
    x += M + 56
    rows.append(f'<g transform="translate({x} {my + M / 2 - 24}) scale(2)">{shapes(fg, ACCENT)}</g>')
    rows.append(f'<text x="{x}" y="{my + M + 30}" fill="{fg}" font-family="sans-serif" font-size="16">mark</text>')
    y += h
sheet = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{y}" viewBox="0 0 {W} {y}"><defs>{"".join(defs)}</defs>{"".join(rows)}</svg>\n'
with open(os.path.join(tmp, 'preview.svg'), 'w') as f:
    f.write(sheet)
subprocess.run(['rsvg-convert', '-o', os.path.join(HERE, 'preview.png'), os.path.join(tmp, 'preview.svg')], check=True)
for f in os.listdir(tmp):
    os.remove(os.path.join(tmp, f))
os.rmdir(tmp)
print(f'mark extent {extent():.2f} units from centre; foreground grid fraction {FG_FRAC:.3f}')

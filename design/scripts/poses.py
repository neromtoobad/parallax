# Cut each agent's pose sheets into one sprite strip for the workroom: the background keyed out, every pose turned
# to face right, scaled alike, feet on the bottom edge. design/sheets/<name>.webp is a 4x2 grid of standing poses
# (its walks and its fourth pose, typing seen from behind, are no longer used); <name>-walk.webp is a 1x4 walk cycle
# seen side on (contact, passing, other contact, passing); <name>-seat.webp has two poses seated facing out, laptop
# on the knees: typing, and looking up.
#   <python with numpy, scipy, pillow> design/scripts/poses.py [name ...]
# Frame order in the strip: idle, walk1-4, type, cheer, bid, box, coin, look.
import glob, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

SRC, OUT = 'design/sheets', 'web/public/agents/poses'
FRAMES = ['idle', 'walk1', 'walk2', 'walk3', 'walk4', 'type', 'cheer', 'bid', 'box', 'coin', 'look']
STAND = 200            # standing height in the strip, px
WALK = 198             # height of the tallest walk pose (passing, one leg straight)
SEATED = 156           # seated height (stool to hair), px
CELL = (150, 250)      # one frame, px; feet sit 4 px above the bottom
# Which way each pose faces on the sheet. The prompt asked for walks and the box facing right and the rest in a
# three-quarter turn to the left, but a few sheets came out otherwise.
FACE = {f: 'L' for f in ('idle', 'bid', 'coin')} | {f: 'R' for f in ('walk1', 'walk2', 'walk3', 'walk4', 'box')} | {'type': '-', 'cheer': '-', 'look': '-'}
ODD = {
    'sol': {'coin': 'R'},
    'kit': {'coin': 'R'},
}
# Lux's white coat is shaded in nearly the sheet's grey, so only the edge-connected background is keyed there.
POCKETS = {'lux': 0}
NEAR = {'lux': 4}
os.makedirs(OUT, exist_ok=True)


def key(im, pockets=6, tol=14):
    a = np.asarray(im.convert('RGB')).astype(int)
    border = np.concatenate([a[:4].reshape(-1, 3), a[-4:].reshape(-1, 3), a[:, :4].reshape(-1, 3), a[:, -4:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    d = np.abs(a - bg).max(axis=2)
    # Background is what is near the grey and connected to the edge, plus big enclosed pockets of exact grey
    # (between an arm and the body).
    near = d <= tol
    lab, n = ndimage.label(near)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bgm = np.isin(lab, edge[edge > 0])
    lab2, n2 = ndimage.label((d <= pockets) & ~bgm)
    if n2 and pockets:
        sizes = ndimage.sum(np.ones_like(d), lab2, range(1, n2 + 1))
        bgm |= np.isin(lab2, 1 + np.flatnonzero(sizes > 600))
    fg = ~bgm
    fg = ndimage.binary_opening(fg, iterations=1)
    # drop specks
    lab3, n3 = ndimage.label(fg)
    if n3:
        sizes = ndimage.sum(fg, lab3, range(1, n3 + 1))
        fg = np.isin(lab3, 1 + np.flatnonzero(sizes > 80))
    return a.astype(np.uint8), fg


def cut(profile, parts, lo, hi):
    """Split points where the profile is emptiest, one near each expected boundary."""
    out, n = [], len(profile)
    for k in range(1, parts):
        c = n * k // parts
        w = slice(max(lo, c - n // (parts * 3)), min(hi, c + n // (parts * 3)))
        seg = profile[w]
        out.append(w.start + int(np.flatnonzero(seg == seg.min())[len(np.flatnonzero(seg == seg.min())) // 2]))
    return [0] + out + [n]


def frames_of(path, name, nrows, ncols):
    a, fg = key(Image.open(path), POCKETS.get(name, 6), NEAR.get(name, 14))
    rows = cut(fg.sum(axis=1), nrows, 0, fg.shape[0])
    found = []
    for r in range(nrows):
        y0, y1 = rows[r], rows[r + 1]
        cols = cut(fg[y0:y1].sum(axis=0), ncols, 0, fg.shape[1])
        for c in range(ncols):
            x0, x1 = cols[c], cols[c + 1]
            m = fg[y0:y1, x0:x1]
            ys, xs = np.nonzero(m)
            by0, by1, bx0, bx1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            rgba = np.dstack([a[y0:y1, x0:x1], (m * 255).astype(np.uint8)])[by0:by1, bx0:bx1]
            found.append(rgba)
    return found


def anchor_x(alpha):
    """Horizontal centre of the torso: the middle band of the figure, where arms and props matter least."""
    h = alpha.shape[0]
    band = alpha[int(h * 0.35):int(h * 0.7)] > 0
    xs = np.nonzero(band)[1]
    return float(xs.mean()) if len(xs) else alpha.shape[1] / 2


def build(name):
    stand = frames_of(f'{SRC}/{name}.webp', name, 2, 4)
    walk = frames_of(f'{SRC}/{name}-walk.webp', name, 1, 4)
    seat = frames_of(f'{SRC}/{name}-seat.webp', name, 1, 2)
    fr = stand[:1] + walk + [seat[0]] + stand[4:] + [seat[1]]
    tall = max(w.shape[0] for w in walk)
    face = FACE | ODD.get(name, {})
    strip = Image.new('RGBA', (CELL[0] * len(FRAMES), CELL[1]), (0, 0, 0, 0))
    for i, (f, px) in enumerate(zip(FRAMES, fr)):
        scale = (SEATED / seat[0].shape[0]) if f in ('type', 'look') else (WALK / tall) if f.startswith('walk') else (STAND / stand[0].shape[0])
        im = Image.fromarray(px)
        if face[f] == 'L':
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        w, h = im.size
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        al = np.asarray(im)[:, :, 3]
        ax = anchor_x(al)
        x = round(i * CELL[0] + CELL[0] / 2 - ax)
        y = CELL[1] - 4 - im.size[1]
        cell = Image.new('RGBA', CELL, (0, 0, 0, 0))
        cell.paste(im, (x - i * CELL[0], y), im)
        strip.alpha_composite(cell, (i * CELL[0], 0))
    strip.save(f'{OUT}/{name}.webp', quality=88, method=6)
    strip.save(f'/private/tmp/claude-501/-Users-mac-Documents-Hacks/6cdfbe4f-1f4d-4f3a-b078-f15dbb904db3/scratchpad/strip-{name}.png')
    feet = [int(np.ptp(np.nonzero(w[-max(4, w.shape[0] // 25):, :, 3].any(axis=0))[0]) * WALK / tall) for w in walk[::2]]
    print(name, os.path.getsize(f'{OUT}/{name}.webp') // 1024, 'KB', 'contact feet span', feet)


names = sys.argv[1:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(f'{SRC}/*.webp') if '-' not in os.path.basename(f))
for n in names:
    build(n)

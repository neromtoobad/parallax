# Cut the characters out of their plain studio backgrounds for the workroom: flood-fill the background from
# the edges, feather the edge a little, trim, and save a small transparent PNG per agent. Needs only Pillow.
#   python3 design/scripts/cutout.py
import glob, os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

SRC = 'web/public/agents'
OUT = 'web/public/agents/cut'
KEY = (255, 0, 255)
os.makedirs(OUT, exist_ok=True)

for f in sorted(glob.glob(f'{SRC}/*.jpg')):
    im = Image.open(f).convert('RGB')
    w, h = im.size
    work = im.copy()
    seeds = [(x, y) for x in range(0, w, 40) for y in (0, h - 1)] + [(x, y) for y in range(0, h, 40) for x in (0, w - 1)]
    for s in seeds:
        if work.getpixel(s) != KEY:
            ImageDraw.floodfill(work, s, KEY, thresh=28)
    # Pockets of background the edge fill can't reach (between an arm and the body): fill any patch that is
    # nearly the background colour and big enough not to be a highlight on clothes.
    ref = im.getpixel((2, 2))
    near = lambda p: max(abs(p[i] - ref[i]) for i in range(3)) < 10
    for y in range(20, h - 20, 24):
        for x in range(20, w - 20, 24):
            if work.getpixel((x, y)) == KEY or not near(work.getpixel((x, y))):
                continue
            trial = work.copy()
            before = trial.histogram()
            ImageDraw.floodfill(trial, (x, y), KEY, thresh=14)
            filled = sum(1 for p in trial.getdata() if p == KEY) - sum(1 for p in work.getdata() if p == KEY)
            if filled > 1500:
                work = trial
    diff = ImageChops.difference(work, Image.new('RGB', im.size, KEY)).convert('L')
    alpha = diff.point(lambda v: 255 if v > 8 else 0).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    rgba = im.copy()
    rgba.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
    rgba = rgba.crop(box)
    rgba.thumbnail((400, 360), Image.LANCZOS)
    name = os.path.basename(f)[:-4]
    rgba.save(f'{OUT}/{name}.png', optimize=True)
    print(name, rgba.size)

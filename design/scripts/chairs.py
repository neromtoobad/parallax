# Lift the nine desk chairs out of the stage picture, so a seated agent can be drawn between the desk and the
# chair back: web/public/stage-chairs.webp, the chairs alone on transparent, placed over the stage at BOX.
#   <python with numpy, scipy, pillow> design/scripts/chairs.py
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

CHAIRS = [190, 267, 350, 430, 507, 585, 662, 772, 855]  # chair centres, stage px
BOX = (150, 644, 896, 724)                              # x0, y0, x1, y1 on the 1115 x 1102 stage
HALF = 37

im = Image.open('web/public/stage.jpg').convert('RGB')
a = np.asarray(im).astype(int)
lum = a @ np.array([0.299, 0.587, 0.114])
x0, y0, x1, y1 = BOX
ys, xs = np.mgrid[y0:y1, x0:x1]
cols = np.zeros_like(xs, dtype=bool)
for c in CHAIRS:
    cols |= np.abs(xs - c) <= HALF
dark = lum[y0:y1, x0:x1] < 58
m = dark & cols
m = ndimage.binary_closing(m, iterations=1)
# keep the chair-sized blobs only (desk legs and lamp stems are thin and stand alone)
lab, n = ndimage.label(m)
sizes = ndimage.sum(m, lab, range(1, n + 1))
m = np.isin(lab, 1 + np.flatnonzero(sizes > 400))
alpha = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
out = im.crop(BOX).convert('RGBA')
out.putalpha(alpha)
out.save('web/public/stage-chairs.webp', quality=90, method=6)
print('stage-chairs.webp', out.size, 'left %.3f%% top %.3f%% width %.3f%% height %.3f%%' % (x0 / 11.15, y0 / 11.02, (x1 - x0) / 11.15, (y1 - y0) / 11.02))

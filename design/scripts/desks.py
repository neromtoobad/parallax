# The desk floor of web/public/stage.jpg is design/scene/desk-floor.webp (an inpaint of the old floor, resized to
# 1115 x 1102) pasted into the rectangle (40, 476)-(942, 740) with a 3 px feather. Agents sit behind two long desks
# facing out, so this lifts each desk front out of the stage as its own layer, drawn over the row seated behind it:
# web/public/stage-desk-back.webp and stage-desk-front.webp, placed over the stage at BACK and FRONT.
#   <python with numpy, scipy, pillow> design/scripts/desks.py
from PIL import Image

BACK = (202, 629, 908, 700)   # the raised back desk, x0, y0, x1, y1 in stage px
FRONT = (150, 657, 837, 743)  # the front desk with its glow strip

im = Image.open('web/public/stage.jpg').convert('RGB')
for name, box in (('back', BACK), ('front', FRONT)):
    im.crop(box).save(f'web/public/stage-desk-{name}.webp', quality=90, method=6)
    x0, y0, x1, y1 = box
    print(f'.wr-desk.{name}{{left:{x0 / 11.15:.3f}%;top:{y0 / 11.02:.3f}%;width:{(x1 - x0) / 11.15:.3f}%;height:{(y1 - y0) / 11.02:.3f}%}}')

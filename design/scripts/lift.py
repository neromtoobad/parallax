# The stairwell on the right of web/public/stage.jpg is now a glass lift shaft: design/scene/lift-shaft.webp (an
# inpaint of the stage, 2048 x 2048) resized to 1115 x 1102 and pasted into the shaft on each floor with a 3 px
# feather. The car is drawn by the page and passes behind the two floor slabs, so this also lifts the slab faces
# where they cross the shaft into web/public/stage-slab-1.webp and -2.webp, drawn over the car.
#   <python with numpy, scipy, pillow> design/scripts/lift.py
from PIL import Image, ImageDraw, ImageFilter

SHAFT = [(946, 150, 1036, 432), (946, 466, 1036, 742), (946, 776, 1036, 1042)]
SLABS = [(940, 430, 1044, 468), (940, 740, 1044, 778)]

stage = Image.open('web/public/stage.jpg').convert('RGB')
new = Image.open('design/scene/lift-shaft.webp').convert('RGB').resize(stage.size, Image.LANCZOS)
mask = Image.new('L', stage.size, 0)
d = ImageDraw.Draw(mask)
for box in SHAFT:
    d.rectangle((box[0] + 3, box[1] + 3, box[2] - 3, box[3] - 3), fill=255)
stage.paste(new, (0, 0), mask.filter(ImageFilter.GaussianBlur(3)))
stage.save('web/public/stage.jpg', quality=90)
for i, box in enumerate(SLABS, 1):
    stage.crop(box).save(f'web/public/stage-slab-{i}.webp', quality=90, method=6)
    x0, y0, x1, y1 = box
    print(f'.wr-slab.s{i}{{left:{x0 / 11.15:.3f}%;top:{y0 / 11.02:.3f}%;width:{(x1 - x0) / 11.15:.3f}%;height:{(y1 - y0) / 11.02:.3f}%}}')

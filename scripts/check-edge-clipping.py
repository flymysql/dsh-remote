# 检测配图边缘是否存在"被切断的文字"。
#
# 判据：深色面板上的文字是亮色（亮度远高于底色）。若在图片最外侧几像素内
# 出现高亮像素（排除我画的 1px 描边与圆角），说明文字被裁断了。
#
# 为什么需要它：我读不了图，无法用眼睛看出"字被切了"，只能靠像素统计。
import sys
from statistics import median
from PIL import Image

# 我画的描边色 (58,58,72) 亮度约 62；圆角外的画布底色 (13,13,17) 亮度约 14。
# 文字亮度通常 >= 150，取 110 作为安全阈值。
INK = 110


def ink_positions(path, margin=4):
    im = Image.open(path).convert('L')
    W, H = im.size
    px = im.load()
    # Light documentation figures need dark ink detection; old dark panels
    # retain the original bright-ink threshold. Corners sample canvas only.
    background = median([px[x, y] for x in (0, W - 1) for y in (0, H - 1)])
    def is_ink(value):
        return value <= 150 if background > 180 else value >= INK
    hits = {'left': [], 'right': [], 'top': [], 'bottom': []}
    # 跳过圆角：上下各 14px 内不判左右边；左右各 14px 内不判上下边
    corner = 14
    for y in range(corner, H - corner):
        for x in range(margin):
            if is_ink(px[x, y]):
                hits['left'].append((x, y, px[x, y]))
        for x in range(margin):
            if is_ink(px[W - 1 - x, y]):
                hits['right'].append((W - 1 - x, y, px[W - 1 - x, y]))
    for x in range(corner, W - corner):
        for y in range(margin):
            if is_ink(px[x, y]):
                hits['top'].append((x, y, px[x, y]))
        for y in range(margin):
            if is_ink(px[x, H - 1 - y]):
                hits['bottom'].append((x, H - 1 - y, px[x, H - 1 - y]))
    return hits, (W, H)


for path in sys.argv[1:]:
    hits, size = ink_positions(path)
    print(f'--- {path} ({size[0]}x{size[1]}) ---')
    bad = 0
    for edge in ('left', 'right', 'top', 'bottom'):
        n = len(hits[edge])
        if n:
            bad += 1
            ys = sorted({y for _, y, _ in hits[edge]})
            print(f'  边缘"{edge}" 发现 {n} 个高亮像素（疑似文字被裁断），'
                  f'位置范围 {ys[0]}..{ys[-1]}')
        else:
            print(f'  边缘"{edge}" 干净')
    print('  判定:', '边缘有文字被切断！' if bad else '边缘无切断迹象')

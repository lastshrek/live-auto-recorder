#!/usr/bin/env python3
"""直播自动录制 — 应用图标生成器

设计: 深色圆角方形底 + 白色粗圆环 + 红色录制点（经典 REC 样式）。
      红色录制点是录像类应用的通用符号，16px 下仍可辨认。

按目标像素尺寸输出**光学调优**的图标：小尺寸会加粗圆环、放大红色圆点，
否则 16/32px 会糊成一团黑白灰。

用法:
    python3 scripts/icon/gen-icon.py

依赖: macOS（iconutil）、Google Chrome（栅格化 SVG）、ImageMagick（合成 ico）。
"""
import os
import shutil
import subprocess
import sys
import tempfile

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def check_deps():
    """提前检查外部工具，缺什么直接说清楚，而不是跑到一半报错。"""
    missing = []
    if not os.path.exists(CHROME):
        missing.append("Google Chrome（用于栅格化 SVG）")
    for cmd, why in (("magick", "合成 ico / 降采样"), ("iconutil", "打包 icns")):
        if shutil.which(cmd) is None:
            missing.append(f"{cmd}（{why}）")
    if missing:
        sys.exit("缺少依赖:\n  - " + "\n  - ".join(missing))

# ---- 配色（与 src/gui/style.css 的暗色主题同源）----
BG_STOPS = [(0, "#3E4C68"), (0.45, "#202838"), (1, "#080B12")]
RING_STOPS = [(0, "#FFFFFF"), (0.5, "#F0F4FB"), (1, "#C4CFE2")]
DOT_STOPS = [(0, "#FF9C86"), (0.28, "#F84A31"), (0.72, "#DC1B08"), (1, "#9E0C02")]
DISH = "#0C1018"

# 尺寸 -> (环外半径, 环厚, 红点半径)，均为「占圆角方形边长的比例」。
# 小尺寸刻意放大中心元素并加厚圆环，保证环与红点之间始终有可见的暗色间隙。
PROFILE = {
    16:   (0.442, 0.146, 0.176),
    20:   (0.438, 0.143, 0.178),
    24:   (0.434, 0.139, 0.180),
    32:   (0.428, 0.133, 0.185),
    40:   (0.424, 0.126, 0.190),
    48:   (0.420, 0.119, 0.188),
    64:   (0.416, 0.111, 0.186),
    128:  (0.412, 0.104, 0.184),
    256:  (0.410, 0.100, 0.183),
    512:  (0.409, 0.098, 0.182),
    1024: (0.409, 0.098, 0.182),
}


def profile_for(size):
    """取最接近且不大于 size 的比例档位，避免新增尺寸时 KeyError。"""
    if size in PROFILE:
        return PROFILE[size]
    lower = [k for k in PROFILE if k <= size]
    return PROFILE[max(lower) if lower else min(PROFILE)]


def stops(pairs):
    return "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in pairs)


def build_svg(size, pad=0.0, shadow=False):
    """生成 size×size 的 SVG 文本。

    所有几何按圆角方形边长 s 的比例计算，因此 pad 改变内容尺寸时图形同步缩放。
    """
    W = size
    s = W * (1 - 2 * pad)          # 圆角方形边长
    o = W * pad                    # 左上偏移
    cx = cy = W / 2.0
    rx = s * 0.2235                # squircle 圆角（Big Sur 近似）

    r_out, thick, r_dot = profile_for(size)
    R = r_out * s
    T = thick * s
    D = r_dot * s
    dish_r = R + T * 0.40          # 环外的暗色衬托圆
    sw = max(0.5, s * 0.0028)      # 描边宽度

    def g(x):  # 统一保留 2 位小数
        return f"{x:.2f}"

    # 超小尺寸省略高光，避免 1px 噪点
    gloss = ""
    if size >= 48:
        gx, gy = cx - D * 0.30, cy - D * 0.54
        gloss = (
            f'<ellipse cx="{g(gx)}" cy="{g(gy)}" rx="{g(D * 0.62)}" ry="{g(D * 0.42)}" '
            f'fill="url(#gloss)" transform="rotate(-26 {g(gx)} {g(gy)})"/>'
        )

    shadow_svg = ""
    if shadow:
        shadow_svg = (
            f'<rect x="{g(o)}" y="{g(o + s * 0.012)}" width="{g(s)}" height="{g(s)}" '
            f'rx="{g(rx)}" fill="#000000" opacity="0.28" filter="url(#drop)"/>'
        )

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" viewBox="0 0 {W} {W}">
  <defs>
    <linearGradient id="bg" x1="{g(o + s * 0.10)}" y1="{g(o)}" x2="{g(o + s * 0.90)}" y2="{g(o + s)}" gradientUnits="userSpaceOnUse">
      {stops(BG_STOPS)}
    </linearGradient>
    <linearGradient id="top" x1="0" y1="{g(o)}" x2="0" y2="{g(o + s * 0.55)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.13"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ring" x1="{g(cx - R * 0.90)}" y1="{g(cy - R)}" x2="{g(cx + R * 0.90)}" y2="{g(cy + R)}" gradientUnits="userSpaceOnUse">
      {stops(RING_STOPS)}
    </linearGradient>
    <radialGradient id="dot" cx="0.34" cy="0.26" r="0.92">{stops(DOT_STOPS)}</radialGradient>
    <radialGradient id="gloss" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.60"/>
      <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="drop" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="{g(max(1.0, W * 0.012))}"/>
    </filter>
  </defs>
  {shadow_svg}
  <rect x="{g(o)}" y="{g(o)}" width="{g(s)}" height="{g(s)}" rx="{g(rx)}" fill="url(#bg)"/>
  <rect x="{g(o)}" y="{g(o)}" width="{g(s)}" height="{g(s)}" rx="{g(rx)}" fill="url(#top)"/>
  <rect x="{g(o)}" y="{g(o)}" width="{g(s)}" height="{g(s)}" rx="{g(rx)}"
        fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="{g(sw)}"/>
  <circle cx="{g(cx)}" cy="{g(cy)}" r="{g(dish_r)}" fill="{DISH}" fill-opacity="0.72"/>
  <circle cx="{g(cx)}" cy="{g(cy)}" r="{g(R - T / 2)}" fill="none" stroke="url(#ring)" stroke-width="{g(T)}"/>
  <circle cx="{g(cx)}" cy="{g(cy)}" r="{g(D)}" fill="url(#dot)"/>
  {gloss}
</svg>
'''


def render(svg_text, out_png, size, workdir, ss=4):
    """用无头 Chrome 栅格化后降采样，保留透明通道。

    Chrome 的 headless 窗口不会渲染到 ~200px 以下（截图会是全透明空图），
    因此统一按 size*ss 渲染再缩回目标尺寸；超采样同时让小图边缘更干净。
    """
    big = max(size, 256) if size * ss < 256 else size * ss
    ss = big // size
    html = os.path.join(workdir, f".tmp-{size}.html")
    body = svg_text.replace(f'width="{size}" height="{size}"',
                            f'width="{big}" height="{big}"')
    with open(html, "w") as f:
        f.write(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            "html,body{margin:0;padding:0;background:transparent;overflow:hidden;"
            "width:100%;height:100%}svg{display:block}"
            '</style></head><body>' + body + "</body></html>"
        )
    raw = os.path.join(workdir, f".raw-{size}.png")
    subprocess.run(
        [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
         "--disable-dev-shm-usage", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--window-size={big},{big}",
         "--default-background-color=00000000", f"--screenshot={raw}",
         f"file://{os.path.abspath(html)}"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    os.remove(html)
    if ss > 1:
        subprocess.run(
            ["magick", raw, "-filter", "Lanczos", "-resize", f"{size}x{size}",
             "-define", "png:color-type=6", out_png],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.remove(raw)
    else:
        os.replace(raw, out_png)
    # 校验: 渲染结果不能是纯透明空图
    chk = subprocess.run(["magick", out_png, "-format", "%[fx:mean]", "info:"],
                         capture_output=True, text=True, check=True)
    if float(chk.stdout.strip() or 0) <= 0.001:
        raise RuntimeError(f"{size}px 图标渲染为空，请检查 Chrome 无头渲染是否可用")
    return out_png


def main():
    check_deps()
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    build = os.path.join(root, "build")
    # 中间产物放系统临时目录, 不污染仓库; build/ 只留最终图标文件
    tmp_root = tempfile.mkdtemp(prefix="lr-icon-")
    iconset = tmp_root
    macdir = os.path.join(tmp_root, "mac.iconset")
    os.makedirs(build, exist_ok=True)
    os.makedirs(macdir, exist_ok=True)
    try:
        _generate(build, iconset, macdir)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _generate(build, iconset, macdir):
    # macOS: 1024 画布 + 824 内容网格（Apple Big Sur 规范），带投影
    for sz in [16, 32, 64, 128, 256, 512, 1024]:
        render(build_svg(sz, pad=0.0977, shadow=True),
               os.path.join(iconset, f"mac_{sz}.png"), sz, iconset)

    # Windows: 近乎满出血，仅留 2% 呼吸
    win_sizes = [16, 24, 32, 48, 64, 128, 256]
    for sz in win_sizes:
        render(build_svg(sz, pad=0.02),
               os.path.join(iconset, f"win_{sz}.png"), sz, iconset)

    # 通用 PNG / SVG 源文件（满出血版本，便于任意场景直接使用）
    render(build_svg(1024), os.path.join(build, "icon.png"), 1024, iconset)
    with open(os.path.join(build, "icon.svg"), "w") as f:
        f.write(build_svg(1024))

    # 开发期 Dock 用: 与 icns 同样的 824/1024 网格，避免开发模式图标比邻居大一圈
    render(build_svg(1024, pad=0.0977, shadow=True),
           os.path.join(build, "icon-dock.png"), 1024, iconset)

    # ---- macOS .icns ----
    pairs = [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
             (128, "128x128"), (256, "128x128@2x"), (256, "256x256"),
             (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x")]
    for sz, name in pairs:
        subprocess.run(["cp", os.path.join(iconset, f"mac_{sz}.png"),
                        os.path.join(macdir, f"icon_{name}.png")], check=True)
    subprocess.run(["iconutil", "-c", "icns", macdir,
                    "-o", os.path.join(build, "icon.icns")], check=True)

    # ---- Windows .ico ----
    subprocess.run(
        ["magick"] + [os.path.join(iconset, f"win_{sz}.png") for sz in win_sizes]
        + [os.path.join(build, "icon.ico")],
        check=True,
    )

    print("图标已生成:", build)
    print("  icon.icns       (macOS, 16-1024)")
    print("  icon.ico        (Windows, 16/24/32/48/64/128/256)")
    print("  icon.png        (1024px 通用, 满出血)")
    print("  icon-dock.png   (1024px, macOS 824 网格, 开发期 Dock 用)")
    print("  icon.svg        (矢量源文件)")


if __name__ == "__main__":
    main()
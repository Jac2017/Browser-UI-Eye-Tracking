"""Generate EyeD icon: an eye with a tactical reticle overlay."""
from PIL import Image, ImageDraw
import math
import os

def draw_eyed_icon(size):
    """Draw an eye with a tactical reticle overlay at the given size."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx, cy = size / 2, size / 2
    scale = size / 128  # Base design at 128px

    # === EYE SHAPE ===
    # Draw eye white (almond shape using ellipse + mask approach)
    eye_w = 52 * scale
    eye_h = 28 * scale

    # Eye outline (dark border)
    outline_pts = []
    for i in range(360):
        angle = math.radians(i)
        # Almond shape: ellipse with pointed ends
        rx = eye_w
        ry = eye_h * (math.cos(angle * 0.5) ** 0.3 if abs(math.cos(angle)) > 0.01 else 0.3)
        x = cx + rx * math.cos(angle)
        y = cy + ry * math.sin(angle)
        outline_pts.append((x, y))

    # Simpler approach: draw almond eye shape with arcs
    # Upper lid
    upper_pts = []
    lower_pts = []
    for i in range(101):
        t = i / 100.0
        angle = math.pi * t  # 0 to pi
        x = cx - eye_w + 2 * eye_w * t
        # Upper lid: higher arc
        y_upper = cy - eye_h * math.sin(angle) * 1.1
        # Lower lid: lower arc (less pronounced)
        y_lower = cy + eye_h * math.sin(angle) * 0.8
        upper_pts.append((x, y_upper))
        lower_pts.append((x, y_lower))

    # Fill eye white
    eye_shape = upper_pts + list(reversed(lower_pts))
    if len(eye_shape) > 2:
        draw.polygon(eye_shape, fill=(240, 240, 245, 255))
        draw.line(eye_shape + [eye_shape[0]], fill=(40, 50, 70, 255), width=max(1, int(2 * scale)))

    # === IRIS ===
    iris_r = 16 * scale
    # Outer iris (dark ring)
    draw.ellipse(
        [cx - iris_r, cy - iris_r, cx + iris_r, cy + iris_r],
        fill=(30, 100, 160, 255),
        outline=(20, 50, 90, 255),
        width=max(1, int(2 * scale))
    )

    # Inner iris gradient effect (lighter center ring)
    inner_r = 12 * scale
    draw.ellipse(
        [cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r],
        fill=(50, 140, 200, 255)
    )

    # === PUPIL ===
    pupil_r = 6 * scale
    draw.ellipse(
        [cx - pupil_r, cy - pupil_r, cx + pupil_r, cy + pupil_r],
        fill=(10, 10, 15, 255)
    )

    # Highlight / reflection
    hl_r = 2.5 * scale
    hl_x = cx - 3 * scale
    hl_y = cy - 3 * scale
    draw.ellipse(
        [hl_x - hl_r, hl_y - hl_r, hl_x + hl_r, hl_y + hl_r],
        fill=(255, 255, 255, 220)
    )

    # === TACTICAL RETICLE OVERLAY ===
    ret_color = (220, 50, 50, 200)  # Red, slightly transparent
    ret_w = max(1, int(1.5 * scale))

    # Outer reticle circle
    ret_r = 22 * scale
    draw.ellipse(
        [cx - ret_r, cy - ret_r, cx + ret_r, cy + ret_r],
        outline=ret_color,
        width=ret_w
    )

    # Cross hairs - four lines from circle edge outward
    hair_inner = ret_r + 1 * scale
    hair_outer = ret_r + 8 * scale

    # Top
    draw.line([(cx, cy - hair_inner), (cx, cy - hair_outer)], fill=ret_color, width=ret_w)
    # Bottom
    draw.line([(cx, cy + hair_inner), (cx, cy + hair_outer)], fill=ret_color, width=ret_w)
    # Left
    draw.line([(cx - hair_inner, cy), (cx - hair_outer, cy)], fill=ret_color, width=ret_w)
    # Right
    draw.line([(cx + hair_inner, cy), (cx + hair_outer, cy)], fill=ret_color, width=ret_w)

    # Inner tick marks (small lines inside the reticle circle)
    tick_inner = ret_r - 4 * scale
    tick_outer = ret_r - 1 * scale
    tick_w = max(1, int(1 * scale))

    # Cardinal ticks inside circle
    draw.line([(cx, cy - tick_inner), (cx, cy - tick_outer)], fill=ret_color, width=tick_w)
    draw.line([(cx, cy + tick_inner), (cx, cy + tick_outer)], fill=ret_color, width=tick_w)
    draw.line([(cx - tick_inner, cy), (cx - tick_outer, cy)], fill=ret_color, width=tick_w)
    draw.line([(cx + tick_inner, cy), (cx + tick_outer, cy)], fill=ret_color, width=tick_w)

    # Diagonal tick marks (45 degree angles)
    diag_inner = (ret_r - 4 * scale) * 0.707
    diag_outer = (ret_r - 1 * scale) * 0.707
    for dx, dy in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
        draw.line(
            [(cx + dx * diag_inner, cy + dy * diag_inner),
             (cx + dx * diag_outer, cy + dy * diag_outer)],
            fill=ret_color, width=tick_w
        )

    # Center dot (small red dot at exact center)
    cdot_r = 1.5 * scale
    draw.ellipse(
        [cx - cdot_r, cy - cdot_r, cx + cdot_r, cy + cdot_r],
        fill=(220, 50, 50, 180)
    )

    return img


if __name__ == '__main__':
    icon_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(icon_dir, exist_ok=True)

    for size in [16, 32, 48, 128]:
        icon = draw_eyed_icon(size)
        path = os.path.join(icon_dir, f'icon{size}.png')
        icon.save(path)
        print(f'Generated {path} ({size}x{size})')

    print('All icons generated.')

"""Render one screen-share frame to a PNG — a faithful Python port of the C++
``ZoomSDKShareSource::renderFrame`` layout, so the overlay can be eyeballed
before spending meeting time.

This mirrors the C++ (same canvas size, dark background, word-wrap + auto-fit,
centered block, live footer) closely enough to judge legibility and wrapping.
It is NOT byte-identical to the in-meeting render (different cv2 build), but the
layout is the same.

    uv run --with opencv-python-headless --with numpy \
        python preflight/render_share_frame.py --file out/share_text.txt --out /tmp/share.png
"""

from __future__ import annotations

import argparse
import math
import sys

import cv2
import numpy as np

WIDTH, HEIGHT = 1280, 720
FONT = cv2.FONT_HERSHEY_SIMPLEX
MARGIN = 60


def collapse_ws(text: str) -> str:
    return " ".join(text.split())


def wrap(text: str, scale: float, thickness: int, max_width: int) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        if not line:
            line = word
            continue
        cand = f"{line} {word}"
        (w, _), _ = cv2.getTextSize(cand, FONT, scale, thickness)
        if w <= max_width:
            line = cand
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def render(text: str, frame_number: int = 0, elapsed: float = 0.0) -> np.ndarray:
    img = np.full((HEIGHT, WIDTH, 3), (35, 30, 28), dtype=np.uint8)  # dark BGR
    cv2.rectangle(img, (8, 8), (WIDTH - 8, HEIGHT - 8), (90, 80, 75), 3)

    max_text_width = WIDTH - 2 * MARGIN
    cv2.putText(img, "ZOOM BOT - live share", (MARGIN, 70), FONT, 0.9,
                (150, 200, 120), 2, cv2.LINE_AA)

    y_top, y_bottom = 120, HEIGHT - 90
    avail = y_bottom - y_top

    placeholder = not text
    content = text or "listening"
    color = (150, 150, 150) if placeholder else (255, 255, 255)
    thickness = 2 if placeholder else 3

    scale = 2.2 if placeholder else 2.0
    lines, line_h = [content], 0
    while scale >= 0.7:
        lines = wrap(content, scale, thickness, max_text_width)
        (_, h), base = cv2.getTextSize("Ayg", FONT, scale, thickness)
        line_h = h + base + int(scale * 16)
        if len(lines) * line_h <= avail:
            break
        scale -= 0.1
    if placeholder:
        lines = ["listening..."]

    block_h = len(lines) * line_h
    y = y_top + max(0, (avail - block_h) // 2) + int(scale * 36)
    for ln in lines:
        (w, _), _ = cv2.getTextSize(ln, FONT, scale, thickness)
        x = max(MARGIN, (WIDTH - w) // 2)
        cv2.putText(img, ln, (x, y), FONT, scale, color, thickness, cv2.LINE_AA)
        y += line_h

    footer = f"t = {elapsed:.1f} s   frame #{frame_number}"
    cv2.putText(img, footer, (MARGIN, HEIGHT - 40), FONT, 0.7, (140, 140, 140), 2, cv2.LINE_AA)
    bar_x = int((math.sin(elapsed) * 0.5 + 0.5) * (WIDTH - 200 - MARGIN)) + MARGIN
    cv2.rectangle(img, (bar_x, HEIGHT - 30), (bar_x + 140, HEIGHT - 20), (120, 200, 255), -1)
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text", help="Literal text to render")
    src.add_argument("--file", help="Read text from this file (empty -> placeholder)")
    ap.add_argument("--out", required=True, help="Output PNG path")
    args = ap.parse_args()

    if args.text is not None:
        text = collapse_ws(args.text)
    else:
        try:
            text = collapse_ws(open(args.file, encoding="utf-8").read())
        except FileNotFoundError:
            text = ""

    img = render(text)
    if not cv2.imwrite(args.out, img):
        print(f"failed to write {args.out}", file=sys.stderr)
        return 1

    # Report how many non-background pixels were drawn — a blank frame is a fail.
    bg = np.array((35, 30, 28), dtype=np.uint8)
    drawn = int(np.count_nonzero(np.any(img != bg, axis=2)))
    print(f"wrote {args.out}  ({WIDTH}x{HEIGHT}, {drawn} non-background px)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

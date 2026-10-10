"""Rend la vidéo n°1 : capture image par image (30 fps) puis assemble en mp4 avec ffmpeg.
Usage : python3 marketing/video1/render.py [sortie.mp4] [fps]"""
import sys, os, subprocess, shutil, tempfile
from playwright.sync_api import sync_playwright
out = sys.argv[1] if len(sys.argv) > 1 else 'vendia-video1.mp4'
fps = int(sys.argv[2]) if len(sys.argv) > 2 else 30
here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='vframes_')
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1080, 'height': 1920})
    pg.goto('file://' + os.path.join(here, 'index.html')); pg.wait_for_timeout(1500)
    dur = pg.evaluate('window.DURATION'); n = int(dur * fps)
    for i in range(n):
        pg.evaluate('t=>window.__seek(t)', i / fps)
        pg.screenshot(path=os.path.join(tmp, 'f%05d.png' % i))
    b.close()
subprocess.run(['ffmpeg', '-y', '-framerate', str(fps), '-i', os.path.join(tmp, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
shutil.rmtree(tmp)
print('ok', out)

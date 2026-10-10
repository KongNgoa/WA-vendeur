"""Rend la vidéo n°2 (voix off + nappe + sous-titres incrustés).
Prérequis : build_audio.py exécuté (voice.wav, pad.wav, timeline.js dans le dossier AUDIO_DIR).
Usage : python3 marketing/video2/render.py sortie.mp4 [audio_dir] [fps]"""
import sys, os, subprocess, shutil, tempfile
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
here=os.path.dirname(os.path.abspath(__file__))
out=sys.argv[1] if len(sys.argv)>1 else 'vendia-video-2.mp4'
audio=sys.argv[2] if len(sys.argv)>2 else here
fps=int(sys.argv[3]) if len(sys.argv)>3 else 24
tmp=tempfile.mkdtemp(prefix='v2frames_')
def work(args):
    lo,hi=args
    with sync_playwright() as p:
        b=p.chromium.launch(); pg=b.new_page(viewport={'width':1080,'height':1920})
        pg.goto('file://'+os.path.join(here,'index.html')); pg.wait_for_timeout(1500)
        for i in range(lo,hi):
            pg.evaluate('t=>window.__seek(t)',i/fps)
            pg.screenshot(path=os.path.join(tmp,'f%05d.jpg'%i),type='jpeg',quality=93)
        b.close()
    return hi-lo
if __name__=='__main__':
    if os.path.abspath(audio)!=here: shutil.copy(os.path.join(audio,'timeline.js'),os.path.join(here,'timeline.js'))
    with sync_playwright() as p:
        b=p.chromium.launch(); pg=b.new_page(); pg.goto('file://'+os.path.join(here,'index.html')); dur=pg.evaluate('window.DURATION'); b.close()
    n=int(dur*fps); k=2; step=(n+k-1)//k
    with Pool(k) as pool: pool.map(work,[(i*step,min(n,(i+1)*step)) for i in range(k)])
    subprocess.run(['ffmpeg','-y','-framerate',str(fps),'-i',os.path.join(tmp,'f%05d.jpg'),'-i',os.path.join(audio,'voice.wav'),'-i',os.path.join(audio,'pad.wav'),
      '-filter_complex','[1:a]volume=1.0[v];[2:a]volume=0.5[p];[v][p]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]',
      '-map','0:v','-map','[a]','-c:v','libx264','-pix_fmt','yuv420p','-crf','19','-c:a','aac','-b:a','160k','-shortest','-movflags','+faststart',out],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    shutil.rmtree(tmp); print('ok',out)

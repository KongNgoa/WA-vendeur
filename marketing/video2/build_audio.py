"""Génère la voix off (Kokoro, voix française ff_siwis) + une nappe musicale douce, et le fichier timeline.js.
Usage : python3 build_audio.py <kokoro.onnx> <voices.bin> [dossier_sortie]
Modèle : https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0)"""
import sys, json, os, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
here=os.path.dirname(os.path.abspath(__file__)); out=sys.argv[3] if len(sys.argv)>3 else here
k=Kokoro(sys.argv[1],sys.argv[2]); sr=24000
segs=json.load(open(os.path.join(here,'script.json'),encoding='utf-8'))
LEAD,GAP,TAIL=0.8,0.55,3.2
t=LEAD; chunks=[np.zeros(int(LEAD*sr),dtype=np.float32)]; tl=[]
for s in segs:
    a,_=k.create(s['tts'],voice='ff_siwis',speed=0.97,lang='fr-fr'); a=a.astype(np.float32)
    d=len(a)/sr; tl.append({'id':s['id'],'start':round(t,3),'dur':round(d,3),'text':s['text']}); chunks.append(a); chunks.append(np.zeros(int(GAP*sr),dtype=np.float32)); t+=d+GAP
total=t-GAP+TAIL; chunks.append(np.zeros(int(TAIL*sr),dtype=np.float32))
voice=np.concatenate(chunks); voice=voice/max(1e-6,np.abs(voice).max())*0.9
sf.write(os.path.join(out,'voice.wav'),voice,sr)
# nappe musicale originale : accords doux (Cmaj7 - Am7 - Fmaj7 - G6), très discrète
n=len(voice); x=np.arange(n)/sr; pad=np.zeros(n,dtype=np.float32)
prog=[[130.81,164.81,196.0,246.94],[110.0,130.81,164.81,196.0],[87.31,130.81,174.61,220.0],[98.0,146.83,196.0,246.94]]
bar=8.0
for i,ch in enumerate(prog*int(np.ceil(total/bar/4))):
    s0=int(i*bar*sr); s1=min(n,int((i+1)*bar*sr+2*sr))
    if s0>=n: break
    tt=np.arange(s1-s0)/sr; env=np.minimum(1,tt/2.0)*np.minimum(1,(bar+2-tt)/2.0)
    for f in ch: pad[s0:s1]+=(np.sin(2*np.pi*f*tt)+0.4*np.sin(2*np.pi*2*f*tt+tt*0.3))*env*0.12/len(ch)
pad*=(0.85+0.15*np.sin(2*np.pi*x/6.0)); fade=np.minimum(1,x/2.5)*np.minimum(1,(total-x)/3.0); pad*=np.clip(fade,0,1)
sf.write(os.path.join(out,'pad.wav'),pad.astype(np.float32),sr)
open(os.path.join(out,'timeline.js'),'w',encoding='utf-8').write('window.TL='+json.dumps(tl,ensure_ascii=False)+';window.TOTAL='+str(round(total,3))+';')
print('ok',round(total,1),'s',[round(s['dur'],1) for s in tl])

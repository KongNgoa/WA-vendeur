// VENDIA — moteur de bannières publicitaires (canvas). Partagé par le Studio promo et le Super-admin.
// Quatre styles (studio, luxe, pop, minimal) x quatre formats (story, portrait, carré, large).
// Traitement photo : couleur dominante -> palette auto, détourage automatique des fonds unis, ombre portée.
(function(){
'use strict';
const SANS='"Poppins","Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const SERIF='"Playfair Display",Georgia,"Times New Roman",serif';
const FORMATS={story:{w:1080,h:1920},portrait:{w:1080,h:1350},square:{w:1080,h:1080},wide:{w:1200,h:628}};
const PALETTES={
  brand:{a:'#0B1442',b:'#17A2FE',accent:'#1FD37A',accentInk:'#062a1a'},
  gold:{a:'#0b1b33',b:'#27406e',accent:'#e9b949',accentInk:'#1a1203'},
  red:{a:'#7a1020',b:'#d62839',accent:'#ffd84d',accentInk:'#3a0a10'},
  green:{a:'#0d3b27',b:'#1b7a4b',accent:'#f4e285',accentInk:'#0d3b27'},
  violet:{a:'#24104f',b:'#6a3df0',accent:'#ffcf56',accentInk:'#2a1a00'},
  sunset:{a:'#4a1230',b:'#ff6a3d',accent:'#ffe27a',accentInk:'#3a1500'},
  ocean:{a:'#06283d',b:'#1597bb',accent:'#8ff0d4',accentInk:'#06283d'},
  noir:{a:'#0a0a0a',b:'#2b2b2b',accent:'#f5c542',accentInk:'#161100'}
};
// ---------- utilitaires couleur ----------
const hex2rgb=h=>{h=String(h).replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');const n=parseInt(h,16);return[(n>>16)&255,(n>>8)&255,n&255];};
const rgb2hex=(r,g,b)=>'#'+[r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
const mix=(a,b,t)=>{const x=hex2rgb(a),y=hex2rgb(b);return rgb2hex(x[0]+(y[0]-x[0])*t,x[1]+(y[1]-x[1])*t,x[2]+(y[2]-x[2])*t);};
const rgba=(h,al)=>{const c=hex2rgb(h);return 'rgba('+c[0]+','+c[1]+','+c[2]+','+al+')';};
const lum=h=>{const c=hex2rgb(h);return(0.299*c[0]+0.587*c[1]+0.114*c[2])/255;};
function hsl2hex(h,s,l){h=((h%360)+360)%360/360;let r,g,b;if(s===0){r=g=b=l;}else{const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q,f=t=>{if(t<0)t+=1;if(t>1)t-=1;return t<1/6?p+(q-p)*6*t:t<1/2?q:t<2/3?p+(q-p)*(2/3-t)*6:p;};r=f(h+1/3);g=f(h);b=f(h-1/3);}return rgb2hex(r*255,g*255,b*255);}
function rgb2hsl(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h=0,s=0;const l=(mx+mn)/2;if(mx!==mn){const d=mx-mn;s=l>.5?d/(2-mx-mn):d/(mx+mn);h=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4;h*=60;}return[h,s,l];}
// ---------- utilitaires dessin ----------
function rr(ctx,x,y,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function fit(ctx,text,maxW){text=String(text);if(ctx.measureText(text).width<=maxW)return text;while(text.length>1&&ctx.measureText(text+'…').width>maxW)text=text.slice(0,-1);return text.trimEnd()+'…';}
function wrap(ctx,text,maxW,maxLines){const words=String(text).split(/\s+/).filter(Boolean),lines=[];let cur='';for(let i=0;i<words.length;i++){const test=cur?cur+' '+words[i]:words[i];if(ctx.measureText(test).width<=maxW||!cur){cur=test;}else{lines.push(cur);cur=words[i];if(lines.length===maxLines-1){cur=words.slice(i).join(' ');break;}}}if(cur)lines.push(cur);if(lines.length)lines[lines.length-1]=fit(ctx,lines[lines.length-1],maxW);return lines;}
function fitSize(ctx,font,text,maxW,start,min){let s=start;do{ctx.font=font(s);if(ctx.measureText(text).width<=maxW)return s;s-=2;}while(s>=min);return min;}
function spaced(ctx,text,x,y,sp,align){ // texte espacé (lettres) — align left|center|right
  const chars=[...String(text)];let w=0;const ws=chars.map(c=>{const m=ctx.measureText(c).width;w+=m+sp;return m;});w-=sp;
  let cx=align==='center'?x-w/2:align==='right'?x-w:x;const sa=ctx.textAlign;ctx.textAlign='left';chars.forEach((c,i)=>{ctx.fillText(c,cx,y);cx+=ws[i]+sp;});ctx.textAlign=sa;return w;}
// ---------- QR code ----------
function drawQR(ctx,x,y,size,url,fg,bg){
  if(typeof qrcode==='undefined'||!url)return false;
  try{
    const q=qrcode(0,'M');q.addData(String(url));q.make();const n=q.getModuleCount(),pad=Math.round(size*0.07),cs=(size-2*pad)/n;
    ctx.save();rr(ctx,x,y,size,size,size*0.09);ctx.fillStyle=bg||'#fff';ctx.fill();ctx.fillStyle=fg||'#0b1442';
    for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(q.isDark(r,c))ctx.fillRect(Math.floor(x+pad+c*cs),Math.floor(y+pad+r*cs),Math.ceil(cs),Math.ceil(cs));
    ctx.restore();return true;
  }catch(e){return false;}
}
// ---------- traitement de la photo ----------
function scaled(img,maxSide){const w0=img.naturalWidth||img.width,h0=img.naturalHeight||img.height,s=Math.min(1,maxSide/Math.max(w0,h0));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w0*s));c.height=Math.max(1,Math.round(h0*s));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c;}
function dominantPalette(img){
  try{
    const c=document.createElement('canvas');c.width=c.height=40;const x=c.getContext('2d');x.drawImage(img,0,0,40,40);const d=x.getImageData(0,0,40,40).data;
    const buckets={};let n=0;
    for(let i=0;i<d.length;i+=4){const [h,s,l]=rgb2hsl(d[i],d[i+1],d[i+2]);if(s<.22||l<.12||l>.9)continue;const k=Math.round(h/20)%18;(buckets[k]=buckets[k]||{w:0,h:0,s:0,l:0});const w=s*(1-Math.abs(l-.5));buckets[k].w+=w;buckets[k].h+=h*w;buckets[k].s+=s*w;buckets[k].l+=l*w;n++;}
    let best=null;for(const k in buckets)if(!best||buckets[k].w>best.w)best=buckets[k];
    if(!best||n<40)return null;
    const h=best.h/best.w,s=Math.min(.85,best.s/best.w);
    const a=hsl2hex(h,Math.min(.7,s),.14),b=hsl2hex(h,Math.min(.85,s+.1),.42);
    const warm=h>35&&h<75; // jaune/orange : l'accent jaune ne contraste pas
    const accent=warm?'#ffffff':'#ffd84d',accentInk=warm?hsl2hex(h,.6,.12):'#241b00';
    return{a,b,accent,accentInk};
  }catch(e){return null;}
}
// Détourage automatique : fond uni (blanc/gris/couleur) relié aux bords -> transparent. Retourne null si le fond n'est pas uniforme.
function cutout(img){
  try{
    const src=scaled(img,900),w=src.width,h=src.height,ctx=src.getContext('2d'),id=ctx.getImageData(0,0,w,h),d=id.data;
    // image déjà détourée (coins transparents) : on la garde telle quelle
    if(d[3]<12&&d[(w-1)*4+3]<12&&d[((h-1)*w)*4+3]<12)return trim(src);
    const pts=[];for(let x=0;x<w;x+=2){pts.push(x,0,x,h-1);}for(let y=0;y<h;y+=2){pts.push(0,y,w-1,y);}
    let sr=0,sg=0,sb=0,m=0;for(let i=0;i<pts.length;i+=2){const o=(pts[i+1]*w+pts[i])*4;sr+=d[o];sg+=d[o+1];sb+=d[o+2];m++;}
    const mr=sr/m,mg=sg/m,mb=sb/m;let v=0;for(let i=0;i<pts.length;i+=2){const o=(pts[i+1]*w+pts[i])*4;v+=Math.abs(d[o]-mr)+Math.abs(d[o+1]-mg)+Math.abs(d[o+2]-mb);}
    const spread=v/m/3;if(spread>26)return null; // fond non uniforme
    const T=34+spread*1.6,dist=o=>(Math.abs(d[o]-mr)+Math.abs(d[o+1]-mg)+Math.abs(d[o+2]-mb))/3;
    const seen=new Uint8Array(w*h),stack=new Int32Array(w*h);let sp=0,removed=0;
    const push=(x,y)=>{const p=y*w+x;if(seen[p])return;if(dist(p*4)>T)return;seen[p]=1;stack[sp++]=p;};
    for(let x=0;x<w;x++){push(x,0);push(x,h-1);}for(let y=0;y<h;y++){push(0,y);push(w-1,y);}
    while(sp){const p=stack[--sp],x=p%w,y=(p/w)|0;removed++;if(x>0)push(x-1,y);if(x<w-1)push(x+1,y);if(y>0)push(x,y-1);if(y<h-1)push(x,y+1);}
    const ratio=removed/(w*h);if(ratio<.10||ratio>.88)return null;
    // alpha : 0 sur le fond, bord adouci (1 px d'érosion + flou léger)
    const al=new Float32Array(w*h);for(let p=0;p<w*h;p++)al[p]=seen[p]?0:1;
    const er=new Float32Array(al);for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const p=y*w+x;if(al[p]&&(!al[p-1]||!al[p+1]||!al[p-w]||!al[p+w]))er[p]=.45;}
    const out=new Float32Array(er);for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const p=y*w+x;out[p]=(er[p]*4+er[p-1]+er[p+1]+er[p-w]+er[p+w])/8;}
    for(let p=0;p<w*h;p++)d[p*4+3]=Math.round(out[p]*255);
    ctx.putImageData(id,0,0);return trim(src);
  }catch(e){return null;}
}
function trim(c){const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data;let x0=w,y0=h,x1=0,y1=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(d[(y*w+x)*4+3]>24){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}if(x1<=x0||y1<=y0)return null;const o=document.createElement('canvas');o.width=x1-x0+1;o.height=y1-y0+1;o.getContext('2d').drawImage(c,x0,y0,o.width,o.height,0,0,o.width,o.height);return o;}
// Prépare une photo : { photo, cut, palette } — mode : 'auto' | 'cut' | 'photo'
function prepareImage(img,mode){
  if(!img)return null;
  const out={photo:img,cut:null,palette:dominantPalette(img)};
  if(mode!=='photo')out.cut=cutout(img);
  return out;
}
function blurred(img,w,h){const t=document.createElement('canvas');t.width=24;t.height=Math.max(8,Math.round(24*h/w));const x=t.getContext('2d');x.imageSmoothingQuality='high';const s=Math.max(t.width/(img.naturalWidth||img.width),t.height/(img.naturalHeight||img.height)),dw=(img.naturalWidth||img.width)*s,dh=(img.naturalHeight||img.height)*s;x.drawImage(img,(t.width-dw)/2,(t.height-dh)/2,dw,dh);return t;}
// ---------- éléments graphiques ----------
function arrowIcon(ctx,cx,cy,s,color){ctx.save();ctx.strokeStyle=color;ctx.lineWidth=s*.16;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(cx-s*.32,cy);ctx.lineTo(cx+s*.3,cy);ctx.moveTo(cx+s*.04,cy-s*.28);ctx.lineTo(cx+s*.32,cy);ctx.lineTo(cx+s*.04,cy+s*.28);ctx.stroke();ctx.restore();}
function waIcon(ctx,cx,cy,s,color){ctx.save();ctx.fillStyle=color;ctx.beginPath();ctx.arc(cx,cy,s/2,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(cx-s*.38,cy+s*.5);ctx.lineTo(cx-s*.5,cy+s*.2);ctx.lineTo(cx-s*.2,cy+s*.35);ctx.closePath();ctx.fill();ctx.restore();}
function starburst(ctx,cx,cy,r,spikes,fill){ctx.beginPath();for(let i=0;i<spikes*2;i++){const a=Math.PI*i/spikes,rad=i%2?r*.82:r;ctx.lineTo(cx+Math.cos(a)*rad,cy+Math.sin(a)*rad);}ctx.closePath();ctx.fillStyle=fill;ctx.fill();}
function button(ctx,x,y,w,h,label,T,small){
  ctx.save();ctx.shadowColor=rgba(T.accent,.55);ctx.shadowBlur=h*.45;ctx.shadowOffsetY=h*.12;
  rr(ctx,x,y,w,h,h/2);ctx.fillStyle=T.btnBg;ctx.fill();ctx.restore();
  ctx.save();rr(ctx,x,y,w,h,h/2);ctx.clip();const g=ctx.createLinearGradient(0,y,0,y+h);g.addColorStop(0,'rgba(255,255,255,.28)');g.addColorStop(.5,'rgba(255,255,255,0)');ctx.fillStyle=g;ctx.fillRect(x,y,w,h);ctx.restore();
  ctx.save();rr(ctx,x-h*.07,y-h*.07,w+h*.14,h+h*.14,(h+h*.14)/2);ctx.lineWidth=Math.max(2,h*.03);ctx.strokeStyle=rgba(T.btnBg,.4);ctx.stroke();ctx.restore();
  const circ=h*.62,cx=x+w-h*.5,pad=h*.35;
  ctx.fillStyle=T.btnInk;ctx.textBaseline='middle';ctx.textAlign='left';
  let fs=h*(small?.34:.38);ctx.font='800 '+fs+'px '+SANS;const maxW=w-circ-pad*2-h*.1;while(ctx.measureText(label).width+ (label.length*fs*.04)>maxW&&fs>14){fs-=2;ctx.font='800 '+fs+'px '+SANS;}
  spaced(ctx,label,x+pad+h*.1,y+h*.52,fs*.05,'left');
  ctx.beginPath();ctx.arc(cx,y+h/2,circ/2,0,Math.PI*2);ctx.fillStyle=T.btnInk;ctx.fill();arrowIcon(ctx,cx,y+h/2,circ*.62,T.btnBg);
  ctx.textBaseline='alphabetic';
}
function badge(ctx,text,x,y,h,T,align,maxW){
  ctx.font='800 '+Math.round(h*.5)+'px '+SANS;const tw=Math.min(maxW,ctx.measureText(text).width+h*1.1),bx=align==='center'?x-tw/2:x;
  rr(ctx,bx,y,tw,h,h/2);ctx.fillStyle=T.accent;ctx.fill();ctx.fillStyle=T.accentInk;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(fit(ctx,text,tw-h*.7),bx+tw/2,y+h*.54);ctx.textBaseline='alphabetic';return tw;
}
// ---------- maquette téléphone (conversation WhatsApp) ----------
function phone(ctx,r,chat,opt){
  opt=opt||{};const BW=420,BH=860,s=Math.min(r.w/BW,r.h/BH),ox=r.x+(r.w-BW*s)/2,oy=r.y+(r.h-BH*s)/2;
  ctx.save();ctx.translate(ox,oy);ctx.scale(s,s);
  ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=60;ctx.shadowOffsetY=30;rr(ctx,0,0,BW,BH,60);ctx.fillStyle='#10131c';ctx.fill();ctx.shadowColor='transparent';
  rr(ctx,10,10,BW-20,BH-20,52);ctx.fillStyle='#e9e2d6';ctx.fill();ctx.save();rr(ctx,10,10,BW-20,BH-20,52);ctx.clip();
  // fond de conversation
  ctx.fillStyle='#e9e2d6';ctx.fillRect(10,10,BW-20,BH-20);ctx.fillStyle='rgba(0,0,0,.035)';for(let yy=90;yy<BH;yy+=44)for(let xx=(yy/44%2)*22+20;xx<BW;xx+=44){ctx.beginPath();ctx.arc(xx,yy,3,0,6.3);ctx.fill();}
  // en-tête
  ctx.fillStyle='#0b6b57';ctx.fillRect(10,10,BW-20,112);ctx.fillStyle='#fff';ctx.font='600 22px '+SANS;ctx.textAlign='left';ctx.textBaseline='alphabetic';
  ctx.beginPath();ctx.arc(70,80,26,0,6.3);ctx.fillStyle='#1FD37A';ctx.fill();ctx.fillStyle='#062a1a';ctx.font='800 24px '+SANS;ctx.textAlign='center';ctx.fillText('V',70,89);
  ctx.textAlign='left';ctx.fillStyle='#fff';ctx.font='700 24px '+SANS;ctx.fillText(opt.name||'Votre boutique',108,76);ctx.font='500 17px '+SANS;ctx.fillStyle='rgba(255,255,255,.8)';ctx.fillText(opt.status||'en ligne',108,100);
  // bulles
  let y=146;const maxW=BW-20-110;
  for(const m of chat){
    const ai=m.from==='ai'||m.from==='me',fs=m.big?25:23;ctx.font='500 '+fs+'px '+SANS;const lines=wrap(ctx,m.text,maxW-36,m.lines||6),lh=fs*1.38;
    const tw=Math.min(maxW,Math.max(...lines.map(l=>ctx.measureText(l).width))+36),bh=lines.length*lh+34;
    const bx=ai?BW-10-18-tw:10+18;
    ctx.save();ctx.shadowColor='rgba(0,0,0,.12)';ctx.shadowBlur=6;ctx.shadowOffsetY=2;rr(ctx,bx,y,tw,bh,20);ctx.fillStyle=ai?'#d9fdd3':'#ffffff';ctx.fill();ctx.restore();
    ctx.fillStyle='#111b21';ctx.textAlign='left';lines.forEach((l,i)=>ctx.fillText(l,bx+18,y+30+i*lh));
    if(m.meta){ctx.font='500 15px '+SANS;ctx.fillStyle='#667781';ctx.textAlign='right';ctx.fillText(m.meta,bx+tw-14,y+bh-8);}
    y+=bh+16;
  }
  ctx.restore();
  // encoche
  rr(ctx,BW/2-62,22,124,30,15);ctx.fillStyle='#10131c';ctx.fill();
  ctx.restore();
}
// ---------- mise en page ----------
function layout(fmt){
  const f=FORMATS[fmt]||FORMATS.story,W=f.w,H=f.h,L={W,H,fmt};
  if(fmt==='story'){Object.assign(L,{tall:true,pad:64,kicker:{y:122,size:40},badge:{y:168,h:84},hero:{x:48,y:300,w:W-96,h:800},title:{y:1190,size:78,lh:90,lines:2},sub:{size:36},price:{y:1412,h:124,size:82},cta:{y:1570,h:132},qr:{s:200},label:{dy:30},contact:{y:1842},footer:{y:1896}});}
  else if(fmt==='portrait'){Object.assign(L,{tall:true,pad:60,kicker:{y:92,size:34},badge:{y:128,h:72},hero:{x:44,y:228,w:W-88,h:470},title:{y:762,size:64,lh:72,lines:2},sub:{size:30},price:{y:966,h:96,size:62},cta:{y:1090,h:118},qr:{s:160},label:{dy:26},contact:{y:1304},footer:{y:1336}});}
  else if(fmt==='square'){Object.assign(L,{tall:true,pad:54,kicker:{y:76,size:30},badge:{y:104,h:62},hero:{x:40,y:186,w:W-80,h:390},title:{y:646,size:54,lh:60,lines:2},sub:{size:26},price:{y:0,h:92,size:56,overlay:true},cta:{y:846,h:112},qr:{s:148},label:{dy:24},contact:{y:1032},footer:{y:1064}});}
  else {Object.assign(L,{tall:false,pad:40,hero:{x:30,y:30,w:520,h:568},col:{x:590,w:W-590-40},kicker:{y:62,size:22},badge:{y:84,h:44},title:{y:196,size:46,lh:54,lines:2},sub:{size:22},price:{y:330,h:78,size:50},cta:{y:440,h:84},qr:{s:104},label:{dy:0},contact:{y:566},footer:{y:604}});}
  return L;
}
// ---------- rendu ----------
function render(canvas,spec){
  const L=layout(spec.format),W=L.W,H=L.H;canvas.width=W;canvas.height=H;const ctx=canvas.getContext('2d');
  const style=spec.style||'studio',P=Object.assign({},PALETTES.brand,spec.palette||{});
  const T=theme(style,P);
  ctx.textBaseline='alphabetic';ctx.textAlign='center';
  background(ctx,L,style,P,T,spec);
  hero(ctx,L,style,P,T,spec);
  texts(ctx,L,style,P,T,spec);
  return canvas;
}
function theme(style,P){
  if(style==='minimal')return{ink:P.a,muted:rgba(P.a,.65),accent:P.b,accentInk:'#fff',btnBg:P.a,btnInk:'#fff',title:SANS,titleW:'800',light:true,priceInk:P.a};
  if(style==='luxe')return{ink:'#f6f1e4',muted:'rgba(246,241,228,.7)',accent:P.accent,accentInk:P.accentInk,btnBg:P.accent,btnInk:P.accentInk,title:SERIF,titleW:'700',priceInk:P.accent};
  if(style==='pop')return{ink:'#ffffff',muted:'rgba(255,255,255,.85)',accent:P.accent,accentInk:P.accentInk,btnBg:P.accent,btnInk:P.accentInk,title:SANS,titleW:'900',priceInk:P.accentInk};
  return{ink:'#ffffff',muted:'rgba(255,255,255,.82)',accent:P.accent,accentInk:P.accentInk,btnBg:P.accent,btnInk:P.accentInk,title:SANS,titleW:'800',priceInk:P.accentInk};
}
function background(ctx,L,style,P,T,spec){
  const W=L.W,H=L.H;
  if(style==='minimal'){
    ctx.fillStyle='#f7f4ee';ctx.fillRect(0,0,W,H);
    ctx.fillStyle=rgba(P.b,.16);ctx.beginPath();ctx.arc(L.hero.x+L.hero.w*.5,L.hero.y+L.hero.h*.52,Math.min(L.hero.w,L.hero.h)*.62,0,6.3);ctx.fill();
    ctx.fillStyle=rgba(P.accent,.35);ctx.beginPath();ctx.arc(W*.92,H*.06,Math.min(W,H)*.16,0,6.3);ctx.fill();
    ctx.fillStyle=rgba(P.a,.06);ctx.beginPath();ctx.arc(W*.05,H*.97,Math.min(W,H)*.2,0,6.3);ctx.fill();
  } else if(style==='luxe'){
    const base=mix(P.a,'#000000',.55);ctx.fillStyle=base;ctx.fillRect(0,0,W,H);
    const cx=L.hero.x+L.hero.w/2,cy=L.hero.y+L.hero.h*.5,g=ctx.createRadialGradient(cx,cy,10,cx,cy,Math.max(L.hero.w,L.hero.h)*.85);g.addColorStop(0,rgba(mix(P.b,'#ffffff',.1),.55));g.addColorStop(1,rgba(P.b,0));ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    ctx.strokeStyle=rgba(P.accent,.75);ctx.lineWidth=3;rr(ctx,24,24,W-48,H-48,6);ctx.stroke();ctx.strokeStyle=rgba(P.accent,.3);ctx.lineWidth=1.5;rr(ctx,36,36,W-72,H-72,4);ctx.stroke();
  } else if(style==='pop'){
    ctx.fillStyle=P.b;ctx.fillRect(0,0,W,H);
    ctx.fillStyle=P.a;ctx.beginPath();ctx.moveTo(0,H*.46);ctx.lineTo(W,H*.30);ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.closePath();ctx.fill();
    ctx.fillStyle=rgba('#ffffff',.12);const step=Math.max(26,Math.round(W/36));for(let y=0;y<H*.5;y+=step)for(let x=((y/step)%2)*step/2;x<W;x+=step){const rad=step*.16*(1-y/(H*.55));if(rad>1){ctx.beginPath();ctx.arc(x,y,rad,0,6.3);ctx.fill();}}
    ctx.fillStyle=P.accent;ctx.beginPath();ctx.arc(L.hero.x+L.hero.w*.5,L.hero.y+L.hero.h*.5,Math.min(L.hero.w,L.hero.h)*.46,0,6.3);ctx.fill();
  } else { // studio
    const g=ctx.createLinearGradient(0,0,W,H);g.addColorStop(0,P.a);g.addColorStop(1,P.b);ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    const hi=spec.hero&&spec.hero.photo&&!spec.hero.cut;if(hi){ctx.globalAlpha=.16;ctx.imageSmoothingEnabled=true;const b=blurred(spec.hero.photo,W,H);ctx.drawImage(b,0,0,W,H);ctx.globalAlpha=1;}
    ctx.fillStyle='rgba(255,255,255,.07)';ctx.beginPath();ctx.arc(W*.95,H*.06,Math.min(W,H)*.34,0,6.3);ctx.fill();ctx.beginPath();ctx.arc(W*.02,H*.96,Math.min(W,H)*.28,0,6.3);ctx.fill();
    const cx=L.hero.x+L.hero.w/2,cy=L.hero.y+L.hero.h*.52,r=Math.min(L.hero.w,L.hero.h)*.56,rg=ctx.createRadialGradient(cx,cy,r*.1,cx,cy,r);rg.addColorStop(0,'rgba(255,255,255,.34)');rg.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=rg;ctx.beginPath();ctx.arc(cx,cy,r,0,6.3);ctx.fill();
  }
}
function hero(ctx,L,style,P,T,spec){
  const h=spec.hero,R=L.hero;if(!h)return;
  if(h.type==='phone'){phone(ctx,R,h.chat||[],{name:h.name,status:h.status});return;}
  if(h.cut){
    const pad=Math.min(R.w,R.h)*.05,bw=R.w-2*pad,bh=R.h-2*pad,s=Math.min(bw/h.cut.width,bh/h.cut.height),dw=h.cut.width*s,dh=h.cut.height*s,x=R.x+(R.w-dw)/2,y=R.y+(R.h-dh)/2-R.h*.02;
    // ombre au sol
    ctx.save();const gy=y+dh+R.h*.005;const eg=ctx.createRadialGradient(R.x+R.w/2,gy,2,R.x+R.w/2,gy,dw*.5);eg.addColorStop(0,style==='minimal'?'rgba(0,0,0,.28)':'rgba(0,0,0,.45)');eg.addColorStop(1,'rgba(0,0,0,0)');ctx.translate(0,gy);ctx.scale(1,.12);ctx.translate(0,-gy);ctx.fillStyle=eg;ctx.beginPath();ctx.arc(R.x+R.w/2,gy,dw*.5,0,6.3);ctx.fill();ctx.restore();
    ctx.save();if(style==='pop'){ctx.translate(R.x+R.w/2,R.y+R.h/2);ctx.rotate(-.07);ctx.translate(-(R.x+R.w/2),-(R.y+R.h/2));}
    ctx.shadowColor='rgba(0,0,0,.38)';ctx.shadowBlur=Math.min(R.w,R.h)*.07;ctx.shadowOffsetY=Math.min(R.w,R.h)*.04;
    try{ctx.filter='contrast(1.05) saturate(1.1)';}catch(e){}ctx.drawImage(h.cut,x,y,dw,dh);ctx.restore();ctx.filter='none';
    return;
  }
  if(h.photo){
    const ph=h.photo,pw=ph.naturalWidth||ph.width,pH=ph.naturalHeight||ph.height;
    ctx.save();if(style==='pop'){ctx.translate(R.x+R.w/2,R.y+R.h/2);ctx.rotate(-.035);ctx.translate(-(R.x+R.w/2),-(R.y+R.h/2));}
    ctx.shadowColor='rgba(0,0,0,.4)';ctx.shadowBlur=50;ctx.shadowOffsetY=26;rr(ctx,R.x,R.y,R.w,R.h,L.tall?44:36);ctx.fillStyle=style==='luxe'?P.accent:'#fff';ctx.fill();ctx.shadowColor='transparent';
    const b=style==='luxe'?5:12,fx=R.x+b,fy=R.y+b,fw=R.w-2*b,fh=R.h-2*b,rad=(L.tall?44:36)-b*.6;
    ctx.save();rr(ctx,fx,fy,fw,fh,rad);ctx.clip();
    const sc=Math.max(fw/pw,fh/pH),asp=(fw/fh)/(pw/pH);
    if(asp>1.3||asp<.77){ // photo très différente du cadre : fond flou + photo entière
      ctx.globalAlpha=.9;const bl=blurred(ph,fw,fh);ctx.drawImage(bl,fx,fy,fw,fh);ctx.globalAlpha=1;ctx.fillStyle='rgba(255,255,255,.18)';ctx.fillRect(fx,fy,fw,fh);
      const s2=Math.min(fw/pw,fh/pH),dw2=pw*s2,dh2=pH*s2;try{ctx.filter='contrast(1.05) saturate(1.1)';}catch(e){}ctx.drawImage(ph,fx+(fw-dw2)/2,fy+(fh-dh2)/2,dw2,dh2);
    } else {const dw=pw*sc,dh=pH*sc;try{ctx.filter='contrast(1.05) saturate(1.1)';}catch(e){}ctx.drawImage(ph,fx+(fw-dw)/2,fy+(fh-dh)/2,dw,dh);}
    ctx.filter='none';ctx.restore();ctx.restore();
    return;
  }
  // pas de photo : pastille
  ctx.save();ctx.fillStyle='rgba(255,255,255,.16)';rr(ctx,R.x,R.y,R.w,R.h,44);ctx.fill();ctx.font=Math.round(Math.min(R.w,R.h)*.4)+'px '+SANS;ctx.textBaseline='middle';ctx.textAlign='center';ctx.fillStyle=T.ink;ctx.fillText('🛍️',R.x+R.w/2,R.y+R.h/2);ctx.restore();
}
function texts(ctx,L,style,P,T,spec){
  const W=L.W,H=L.H,tall=L.tall,cx=W/2;
  const kick=String(spec.kicker||'').toUpperCase(),head=String(spec.headline||'').toUpperCase(),title=String(spec.title||''),sub=String(spec.subtitle||''),price=String(spec.price||''),cta=String(spec.cta||'COMMANDER').toUpperCase();
  const align=tall?'center':'left',X=tall?cx:L.col.x,MW=tall?W-2*L.pad:L.col.w;
  ctx.textAlign=align;
  // kicker
  if(kick){ctx.fillStyle=T.muted;ctx.font=(style==='luxe'?'600 ':'700 ')+L.kicker.size+'px '+(style==='luxe'?SERIF:SANS);const w=style==='luxe'?spaced(ctx,fit(ctx,kick,MW),X,L.kicker.y,L.kicker.size*.18,align):(ctx.fillText(fit(ctx,kick,MW),X,L.kicker.y),0);}
  if(head){badge(ctx,head,X,L.badge.y,L.badge.h,T,align,MW);ctx.textAlign=align;ctx.textBaseline='alphabetic';}
  // titre
  let ty=L.title.y,lastScale=1;
  if(title){
    const font=s=>T.titleW+' '+s+'px '+T.title;ctx.font=font(L.title.size);
    // taille adaptative : si 2 lignes ne suffisent pas, on réduit
    let size=L.title.size,lines;for(;;){ctx.font=font(size);lines=wrap(ctx,title,MW,L.title.lines);const clipped=lines.some(l=>l.endsWith('…'));if(!clipped||size<=L.title.size*.62)break;size-=3;}
    const lh=L.title.lh*(size/L.title.size);lastScale=size/L.title.size;ctx.fillStyle=T.ink;
    if(style==='pop'){ctx.save();ctx.shadowColor=rgba(P.a,.9);ctx.shadowOffsetX=5;ctx.shadowOffsetY=5;}
    lines.forEach((l,i)=>ctx.fillText(l,X,ty+i*lh));if(style==='pop')ctx.restore();
    ty+=lines.length*lh;
  }
  if(sub){ctx.fillStyle=T.muted;ctx.font='500 '+L.sub.size+'px '+SANS;const sl=wrap(ctx,sub,MW,2),sy0=ty-(title?L.title.lh*(lastScale):0)+L.sub.size*1.5;sl.forEach((l,i)=>ctx.fillText(l,X,sy0+i*L.sub.size*1.35));}
  // prix
  if(price){
    const ps=L.price;ctx.font='900 '+ps.size+'px '+SANS;
    if(ps.overlay){ // carré : pastille sur la photo
      const rr0=L.hero,cx2=rr0.x+rr0.w-96,cy2=rr0.y+90;ctx.save();ctx.translate(cx2,cy2);ctx.rotate(.14);ctx.translate(-cx2,-cy2);starburst(ctx,cx2,cy2,118,14,T.accent);ctx.fillStyle=T.accentInk;ctx.textAlign='center';
      const parts=price.replace(/\s*FCFA\s*$/i,''),f2=fitSize(ctx,s=>'900 '+s+'px '+SANS,parts,170,44,22);ctx.font='900 '+f2+'px '+SANS;ctx.fillText(parts,cx2,cy2+f2*.18);ctx.font='700 22px '+SANS;ctx.fillText('FCFA',cx2,cy2+f2*.18+30);ctx.restore();ctx.textAlign=align;
    } else if(style==='luxe'){
      ctx.fillStyle=T.priceInk;const px=fitSize(ctx,s=>'700 '+s+'px '+SERIF,price,MW,ps.size,28);ctx.font='700 '+px+'px '+SERIF;
      const y=tall?ps.y+ps.h*.74:ps.y+ps.h*.74;ctx.fillText(price,X,y);ctx.strokeStyle=rgba(P.accent,.6);ctx.lineWidth=2;const tw=ctx.measureText(price).width,lx=tall?cx-tw/2:X;ctx.beginPath();ctx.moveTo(lx,y+14);ctx.lineTo(lx+tw,y+14);ctx.stroke();
    } else {
      const px=fitSize(ctx,s=>'900 '+s+'px '+SANS,price,MW-ps.h*.8,ps.size,24);ctx.font='900 '+px+'px '+SANS;const tw=Math.min(MW,ctx.measureText(price).width+ps.h*.9),bx=tall?cx-tw/2:X;
      ctx.save();ctx.shadowColor='rgba(0,0,0,.25)';ctx.shadowBlur=20;ctx.shadowOffsetY=8;rr(ctx,bx,ps.y,tw,ps.h,ps.h/2);ctx.fillStyle=style==='minimal'?T.btnBg:T.accent;ctx.fill();ctx.restore();
      ctx.fillStyle=style==='minimal'?'#fff':T.accentInk;ctx.textAlign='center';ctx.fillText(price,bx+tw/2,ps.y+ps.h*.5+px*.34);ctx.textAlign=align;
    }
  }
  // CTA + QR
  const qrOn=!!spec.qrUrl&&typeof qrcode!=='undefined',qs=L.qr.s;
  if(tall){
    const gap=26,bh=L.cta.h,by=L.cta.y,rowH=qrOn?qs:bh,bw=qrOn?W-2*L.pad-qs-gap:W-2*L.pad;
    button(ctx,L.pad,by+(rowH-bh)/2,bw,bh,cta,T);
    if(qrOn){const qx=W-L.pad-qs;drawQR(ctx,qx,by,qs,spec.qrUrl,mix(P.a,'#000000',.2),'#ffffff');ctx.fillStyle=T.muted;ctx.font='700 '+Math.round(qs*.11)+'px '+SANS;ctx.textAlign='center';ctx.fillText(fit(ctx,spec.qrLabel||'SCAN',qs+20),qx+qs/2,by+qs+L.label.dy);}
    ctx.textAlign='center';
    if(spec.contact){ctx.font='700 '+(L.fmt==='story'?40:30)+'px '+SANS;ctx.fillStyle=T.ink;const cw=ctx.measureText(spec.contact).width;waIcon(ctx,cx-cw/2-30-(qrOn?60:0),L.contact.y-(L.fmt==='story'?13:10),L.fmt==='story'?36:28,T.accent);ctx.fillText(spec.contact,cx+18-(qrOn?60:0),L.contact.y);}
    if(spec.footer){ctx.fillStyle=T.muted;ctx.font='500 '+(L.fmt==='story'?26:22)+'px '+SANS;ctx.fillText(spec.footer,cx-(qrOn?60:0),L.footer.y);}
  } else {
    const bx=L.col.x,bw=L.col.w-(qrOn?qs+22:0);
    button(ctx,bx,L.cta.y,bw,L.cta.h,cta,T,true);
    if(qrOn){const qx=L.col.x+L.col.w-qs;drawQR(ctx,qx,L.cta.y-8,qs,spec.qrUrl,mix(P.a,'#000000',.2),'#ffffff');}
    ctx.textAlign='left';
    if(spec.contact){ctx.font='700 24px '+SANS;ctx.fillStyle=T.ink;waIcon(ctx,bx+13,L.contact.y-8,24,T.accent);ctx.fillText(spec.contact,bx+34,L.contact.y);}
    if(spec.footer){ctx.fillStyle=T.muted;ctx.font='500 16px '+SANS;ctx.fillText(spec.footer,bx,L.footer.y);}
  }
}
const ready=(function(){try{if(!document.fonts||!document.fonts.load)return Promise.resolve();const specs=['800 40px Poppins','600 40px Poppins','500 24px Poppins','700 40px "Playfair Display"'];return Promise.race([Promise.all(specs.map(s=>document.fonts.load(s))),new Promise(r=>setTimeout(r,2500))]);}catch(e){return Promise.resolve();}})();
window.VBanner={FORMATS,PALETTES,render,prepareImage,dominantPalette,cutout,drawQR,phone,ready,layout,mix,rgba};
})();

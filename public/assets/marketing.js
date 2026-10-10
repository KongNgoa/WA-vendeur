// VENDIA — espace Marketing du super-admin : générateur de bannières et de campagnes.
// Dépend de superadmin.html (t, api, $, esc, lang) et de banner.js / qr.js.
(function(){
'use strict';
const PRESETS={
 reply:{
  fr:{name:'Répond 24h/24',kicker:'VENDIA',headline:'NOUVEAU',title:'Votre vendeur IA répond à vos clients, même la nuit',subtitle:'Il répond sur WhatsApp, prend les commandes et vous prévient quand il faut.',price:'Dès 10 000 FCFA / mois',cta:'ESSAYER',qrLabel:'ESSAYEZ',footer:'Vendez plus, répondez moins.',
   chat:'C: Bonjour, vous avez la robe bleue en M ?\nV: Bonsoir ! Oui, la robe bleue est disponible en M à 15 000 FCFA. Je vous la réserve ? 😊\nC: Oui, livraison à Bonamoussadi\nV: Parfait, commande enregistrée ✅ Le vendeur vous confirme demain matin.',
   caption:'Il est 23h. Un client vous écrit sur WhatsApp… et vous dormez. 😴\n\nAvec VENDIA, votre vendeur IA répond tout de suite, présente vos produits, prend la commande et vous prévient uniquement quand c\'est nécessaire.\n\n✅ Répond 24h/24 sur WhatsApp\n✅ Prend les commandes\n✅ Relance les clients\n✅ Boutique en ligne incluse\n\nEssayez VENDIA 👉 {link}',hashtags:'#Vendia #WhatsAppBusiness #VenteEnLigne #Cameroun #Douala #Yaoundé #Entrepreneur #CommerceEnLigne'},
  en:{name:'Answers 24/7',kicker:'VENDIA',headline:'NEW',title:'Your AI salesperson answers your customers, even at night',subtitle:'It replies on WhatsApp, takes orders and alerts you only when needed.',price:'From 10,000 FCFA / month',cta:'TRY IT',qrLabel:'TRY IT',footer:'Sell more, reply less.',
   chat:'C: Hi, do you have the blue dress in M?\nV: Good evening! Yes, the blue dress is available in M for 15,000 FCFA. Shall I reserve it? 😊\nC: Yes, delivery to Bonamoussadi\nV: Perfect, order recorded ✅ The seller will confirm tomorrow morning.',
   caption:'It\'s 11 pm. A customer messages you on WhatsApp… and you\'re asleep. 😴\n\nWith VENDIA, your AI salesperson replies instantly, presents your products, takes the order and alerts you only when it matters.\n\n✅ Answers 24/7 on WhatsApp\n✅ Takes orders\n✅ Follows up with customers\n✅ Online shop included\n\nTry VENDIA 👉 {link}',hashtags:'#Vendia #WhatsAppBusiness #OnlineSelling #Cameroon #SmallBusiness #Entrepreneur'}
 },
 orders:{
  fr:{name:'Ne perdez plus aucune commande',kicker:'VENDIA',headline:'COMMERÇANTS',title:'Chaque message WhatsApp devient une vente',subtitle:'Catalogue, réponses, commandes et relances : tout est géré pour vous.',price:'Essai disponible',cta:'COMMENCER',qrLabel:'SCANNEZ',footer:'vendia — le vendeur qui ne dort jamais',
   chat:'C: Salut, c\'est combien les baskets ?\nV: Bonjour ! Les baskets Air sont à 25 000 FCFA, pointures 38 à 45. Quelle pointure vous faut-il ?\nC: 42\nV: Disponible en 42 ✅ Je vous prépare la commande ?',
   caption:'Combien de clients vous écrivent sur WhatsApp et ne reçoivent jamais de réponse ? 📉\n\nVENDIA répond à votre place, 24h/24, et transforme chaque conversation en commande.\n\n👉 {link}',hashtags:'#Vendia #WhatsApp #Vente #Boutique #Cameroun #Business'},
  en:{name:'Never lose an order again',kicker:'VENDIA',headline:'SELLERS',title:'Every WhatsApp message becomes a sale',subtitle:'Catalog, replies, orders and follow-ups: all handled for you.',price:'Free trial available',cta:'GET STARTED',qrLabel:'SCAN ME',footer:'vendia — the seller that never sleeps',
   chat:'C: Hi, how much are the sneakers?\nV: Hello! The Air sneakers are 25,000 FCFA, sizes 38 to 45. Which size do you need?\nC: 42\nV: Available in 42 ✅ Shall I prepare your order?',
   caption:'How many customers message you on WhatsApp and never get an answer? 📉\n\nVENDIA replies for you, 24/7, and turns every conversation into an order.\n\n👉 {link}',hashtags:'#Vendia #WhatsApp #Sales #Shop #Business'}
 },
 shop:{
  fr:{name:'Boutique en ligne en 5 minutes',kicker:'VENDIA',headline:'GRATUIT À ESSAYER',title:'Votre boutique en ligne, prête en quelques minutes',subtitle:'Un lien, un bouton Commander, et les commandes arrivent sur WhatsApp.',price:'Dès 10 000 FCFA / mois',cta:'CRÉER MA BOUTIQUE',qrLabel:'SCANNEZ',footer:'Paiement à la livraison · Livraison locale',chat:'C: Je voudrais commander la robe bleue, taille M\nV: Commande n°1042 enregistrée ✅ Total : 15 000 FCFA, paiement à la livraison.\nV: Vous pouvez aussi commander directement sur notre boutique en ligne 🛍️',
   caption:'Votre boutique en ligne, sans site web compliqué. 🛍️\n\nAjoutez vos produits, partagez votre lien : vos clients commandent en un clic, VENDIA s\'occupe du reste.\n\n👉 {link}',hashtags:'#Vendia #BoutiqueEnLigne #Ecommerce #Cameroun #Entrepreneur'},
  en:{name:'Online shop in 5 minutes',kicker:'VENDIA',headline:'TRY IT FREE',title:'Your online shop, ready in minutes',subtitle:'One link, one Order button, and orders land on WhatsApp.',price:'From 10,000 FCFA / month',cta:'CREATE MY SHOP',qrLabel:'SCAN ME',footer:'Pay on delivery · Local delivery',chat:'C: I\'d like to order the blue dress, size M\nV: Order #1042 recorded ✅ Total: 15,000 FCFA, pay on delivery.\nV: You can also order directly on our online shop 🛍️',
   caption:'Your online shop, no complicated website. 🛍️\n\nAdd your products, share your link: customers order in one tap, VENDIA handles the rest.\n\n👉 {link}',hashtags:'#Vendia #OnlineShop #Ecommerce #Cameroon #Entrepreneur'}
 }
};
const FORMAT_LABEL={story:'story-9x16',portrait:'portrait-4x5',square:'carre-1x1',wide:'lien-1.91x1'};
let curId=null,list=[],ready=false,logoImg=null;
const g=id=>document.getElementById(id);
function parseChat(txt){return String(txt||'').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{const m=l.match(/^([CV]):\s*(.+)$/i);return m?{from:m[1].toUpperCase()==='V'?'ai':'client',text:m[2]}:{from:'client',text:l};}).slice(0,6);}
function linkWithUtm(src){
  const base=(g('mkLink').value.trim()||location.origin),slug=(g('mkName').value||'campagne').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'campagne';
  let u;try{u=new URL(base);}catch(e){return base;}
  u.searchParams.set('utm_source',src);u.searchParams.set('utm_medium','social');u.searchParams.set('utm_campaign',slug);return u.toString();
}
function spec(format){
  const style=g('mkStyle').value,pal=g('mkPalette').value,chat=parseChat(g('mkChat').value);
  const palette=VBanner.PALETTES[pal]||VBanner.PALETTES.brand;
  return{format,style,palette,kicker:g('mkKicker').value,headline:g('mkHeadline').value,title:g('mkTitle').value,subtitle:g('mkSub').value,price:g('mkPrice').value,cta:g('mkCta').value||'ESSAYER',
   qrUrl:g('mkQr').checked?linkWithUtm('qr'):'',qrLabel:g('mkQrLabel').value,contact:g('mkContact').value,footer:g('mkFooter').value,
   hero:chat.length?{type:'phone',chat,name:'VENDIA',status:t('mk_online')}:null};
}
function draw(){
  if(!ready)return;const f=g('mkFormat').value;
  VBanner.ready.then(()=>{const cv=g('mkCanvas');const s=spec(f);if(!s.hero){s.hero=null;}VBanner.render(cv,s);});
  const cap=g('mkCaption');g('mkCapCount').textContent=cap.value.length;
}
function applyPreset(key,keepLang){
  const l=g('mkLang').value,p=(PRESETS[key]||PRESETS.reply)[l];
  g('mkName').value=p.name;g('mkKicker').value=p.kicker;g('mkHeadline').value=p.headline;g('mkTitle').value=p.title;g('mkSub').value=p.subtitle;g('mkPrice').value=p.price;g('mkCta').value=p.cta;g('mkQrLabel').value=p.qrLabel;g('mkFooter').value=p.footer;g('mkChat').value=p.chat;
  g('mkCaption').value=p.caption;g('mkTags').value=p.hashtags;draw();
}
function currentPayload(){
  const f={};['mkStyle','mkPalette','mkFormat','mkKicker','mkHeadline','mkTitle','mkSub','mkPrice','mkCta','mkQrLabel','mkContact','mkFooter','mkChat','mkPreset'].forEach(id=>f[id]=g(id).value);f.mkQr=g('mkQr').checked;
  return{id:curId||undefined,name:g('mkName').value.trim(),spec:f,caption:g('mkCaption').value,hashtags:g('mkTags').value,link:g('mkLink').value.trim(),lang:g('mkLang').value};
}
async function save(){
  const st=g('mkStatus');try{const r=await api('/api/superadmin/marketing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentPayload())});curId=r.id;st.innerHTML='<span class="success">'+esc(t('mk_saved'))+'</span>';await loadList();}catch(e){st.innerHTML='<span class="error">'+esc(e.message)+'</span>';}
}
function newCampaign(){curId=null;g('mkStatus').textContent='';applyPreset(g('mkPreset').value);}
async function loadList(){
  try{const r=await api('/api/superadmin/marketing');list=r.campaigns||[];}catch(e){g('mkList').innerHTML='<div class="error">'+esc(e.message)+'</div>';return;}
  g('mkList').innerHTML=list.length?'<table><tr><th>'+esc(t('mk_col_name'))+'</th><th>'+esc(t('mk_col_date'))+'</th><th></th></tr>'+list.map(c=>'<tr><td>'+esc(c.name)+'</td><td class="muted">'+esc(new Date(c.updatedAt).toLocaleDateString(lang==='en'?'en-GB':'fr-FR'))+'</td><td class="actions"><button class="btn" onclick="VMk.open(\''+c.id+'\')">'+esc(t('mk_open'))+'</button><button class="btn danger" onclick="VMk.del(\''+c.id+'\')">✕</button></td></tr>').join('')+'</table>':'<div class="empty">'+esc(t('mk_empty'))+'</div>';
}
function open_(id){
  const c=list.find(x=>x.id===id);if(!c)return;curId=id;g('mkLang').value=c.lang||'fr';
  Object.entries(c.spec||{}).forEach(([k,v])=>{const el=g(k);if(!el)return;if(k==='mkQr')el.checked=!!v;else el.value=v;});
  g('mkName').value=c.name;g('mkCaption').value=c.caption||'';g('mkTags').value=c.hashtags||'';g('mkLink').value=c.link||'';g('mkStatus').textContent='';draw();window.scrollTo({top:0,behavior:'smooth'});
}
async function del(id){if(!confirm(t('mk_confirm_delete')))return;try{await api('/api/superadmin/marketing/'+id,{method:'DELETE'});if(curId===id)curId=null;await loadList();}catch(e){alert(e.message);}}
function fileName(f){return 'vendia-'+(g('mkName').value||'campagne').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)+'-'+FORMAT_LABEL[f]+'.png';}
function dl(canvas,name){return new Promise(r=>canvas.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);r();},'image/png'));}
async function download(all){
  await VBanner.ready;const formats=all?Object.keys(FORMAT_LABEL):[g('mkFormat').value];
  for(const f of formats){const cv=document.createElement('canvas');VBanner.render(cv,spec(f));await dl(cv,fileName(f));await new Promise(r=>setTimeout(r,350));}
}
function fullCaption(src){return g('mkCaption').value.split('{link}').join(linkWithUtm(src||g('mkChannel').value))+(g('mkTags').value?'\n\n'+g('mkTags').value:'');}
async function copyCaption(){const st=g('mkStatus');try{await navigator.clipboard.writeText(fullCaption());st.innerHTML='<span class="success">'+esc(t('mk_copied'))+'</span>';}catch(e){g('mkCaption').select();st.innerHTML='<span class="error">'+esc(t('mk_copy_fail'))+'</span>';}}
function init(){
  if(ready){draw();return;}ready=true;
  if(!g('mkLink').value)g('mkLink').value=location.origin;
  applyPreset('reply');loadList();
  ['mkStyle','mkPalette','mkFormat','mkKicker','mkHeadline','mkTitle','mkSub','mkPrice','mkCta','mkQrLabel','mkContact','mkFooter','mkChat','mkLink','mkQr'].forEach(id=>g(id).addEventListener('input',draw));
  g('mkCaption').addEventListener('input',draw);
  g('mkPreset').addEventListener('change',()=>applyPreset(g('mkPreset').value));
  g('mkLang').addEventListener('change',()=>applyPreset(g('mkPreset').value));
}
window.VMk={init,save,newCampaign,download,copyCaption,open:open_,del,redraw:draw,loadList};
})();

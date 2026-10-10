// VENDIA — espace Support du super-admin : demandes d'assistance des entreprises.
// Dépend de superadmin.html (t, api, $, esc, lang).
(function(){
'use strict';
const CATS=['whatsapp','ia','produits','boutique','commandes','facturation','compte','bug','suggestion','autre'];
const QUALS=['resolved_team','workaround','not_reproducible','feature_request','duplicate','no_response'];
const g=id=>document.getElementById(id);
let list=[],cur=null,timer=null,filter='open';
const ago=d=>{const s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);return s<90?t('sp_now'):s<5400?Math.round(s/60)+' min':s<172800?Math.round(s/3600)+' h':Math.round(s/86400)+' j';};
const stBadge=s=>'<span class="spBadge st_'+s+'">'+esc(t('sp_st_'+s))+'</span>';
const catLabel=c=>t('sp_cat_'+c);
function qualLabel(q){return q?t('sp_q_'+q):'';}
async function loadList(){
  try{
    const r=await api('/api/superadmin/support?status='+filter);list=r.tickets||[];
    const c=r.counts||{};
    g('spCounts').innerHTML=[['waiting',c.waiting],['replied',c.replied],['ai',c.ai],['resolved',c.resolved]].map(([k,v])=>'<div class="spCount '+k+'"><b>'+(v||0)+'</b><span>'+esc(t('sp_st_'+k))+'</span></div>').join('')+(c.resolved?'<div class="spCount"><b>'+Math.round((c.resolvedAi||0)*100/c.resolved)+'%</b><span>'+esc(t('sp_ai_rate'))+'</span></div>':'');
    setBadge(c.waiting||0);
    g('spList').innerHTML=list.length?list.map(x=>'<div class="spRow'+(cur&&cur.id===x.id?' sel':'')+'" onclick="VSp.open(\''+x.id+'\')"><div class="spTop"><strong>'+esc(x.company)+'</strong>'+(x.unreadAdmin?'<span class="spDot"></span>':'')+'<span class="muted" style="margin-left:auto">'+esc(ago(x.updatedAt))+'</span></div><div class="spSubj">'+esc(x.subject)+'</div><div>'+stBadge(x.status)+'<span class="spBadge cat">'+esc(catLabel(x.category))+'</span>'+(x.priority==='urgent'?'<span class="spBadge urgent">'+esc(t('sp_urgent'))+'</span>':'')+(x.qualification?'<span class="spBadge qual">'+esc(qualLabel(x.qualification))+(x.satisfaction===-1?' 👎':x.satisfaction===1?' 👍':'')+'</span>':'')+'</div></div>').join(''):'<div class="empty">'+esc(t('sp_empty'))+'</div>';
  }catch(e){g('spList').innerHTML='<div class="error">'+esc(e.message)+'</div>';}
}
function setBadge(n){const b=g('spTabBadge');if(!b)return;b.textContent=n;b.classList.toggle('hidden',!n);}
async function open_(id){
  try{
    const r=await api('/api/superadmin/support/'+id);cur=r.ticket;const m=r.messages||[];
    const tk=cur,res=tk.status==='resolved';
    g('spThread').innerHTML='<div class="spHead"><div><strong style="font-size:16px">'+esc(tk.company)+'</strong><div class="muted">'+esc(tk.subject)+'</div></div><div>'+stBadge(tk.status)+'</div></div>'
    +'<div class="spMeta"><label>'+esc(t('sp_category'))+'<select id="spCat" onchange="VSp.meta()">'+CATS.map(c=>'<option value="'+c+'"'+(c===tk.category?' selected':'')+'>'+esc(catLabel(c))+'</option>').join('')+'</select></label><label>'+esc(t('sp_priority'))+'<select id="spPri" onchange="VSp.meta()"><option value="normal"'+(tk.priority!=='urgent'?' selected':'')+'>'+esc(t('sp_normal'))+'</option><option value="urgent"'+(tk.priority==='urgent'?' selected':'')+'>'+esc(t('sp_urgent'))+'</option></select></label></div>'
    +(tk.summary?'<div class="spSummary"><b>'+esc(t('sp_summary'))+'</b> '+esc(tk.summary)+(tk.escalateReason?' <span class="muted">('+esc(t('sp_reason_'+tk.escalateReason))+')</span>':'')+'</div>':'')
    +(res?'<div class="spResolved">✅ '+esc(t('sp_resolved_as'))+' <b>'+esc(qualLabel(tk.qualification))+'</b>'+(tk.satisfaction===-1?' 👎':tk.satisfaction===1?' 👍':'')+(tk.resolutionNote?' — '+esc(tk.resolutionNote):'')+' <button class="btn" onclick="VSp.reopen()">'+esc(t('sp_reopen'))+'</button></div>':'')
    +'<div class="spMsgs" id="spMsgs">'+m.map(x=>'<div class="spMsg '+x.sender+'"><span class="who">'+esc(t('sp_from_'+x.sender))+' · '+esc(new Date(x.at).toLocaleString(lang==='en'?'en-GB':'fr-FR',{dateStyle:'short',timeStyle:'short'}))+'</span>'+esc(x.body)+'</div>').join('')+'</div>'
    +(res?'':'<textarea id="spReply" rows="3" placeholder="'+esc(t('sp_reply_ph'))+'" style="width:100%;padding:10px;border:1px solid #d9deea;border-radius:10px;font:inherit;font-size:14px"></textarea><div class="actions" style="margin-top:8px;align-items:center"><button class="btn primary" onclick="VSp.reply()">'+esc(t('sp_send'))+'</button><span style="flex:1"></span><select id="spQual" style="width:auto">'+QUALS.map(q=>'<option value="'+q+'">'+esc(qualLabel(q))+'</option>').join('')+'</select><button class="btn" onclick="VSp.resolve()">✅ '+esc(t('sp_close'))+'</button></div>')
    +'<div id="spMsg" style="margin-top:8px"></div>';
    const box=g('spMsgs');if(box)box.scrollTop=box.scrollHeight;loadList();
  }catch(e){g('spThread').innerHTML='<div class="error">'+esc(e.message)+'</div>';}
}
async function reply(){const b=g('spReply').value.trim();if(!b)return;try{await api('/api/superadmin/support/'+cur.id+'/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:b})});await open_(cur.id);}catch(e){g('spMsg').innerHTML='<span class="error">'+esc(e.message)+'</span>';}}
async function resolve(){try{await api('/api/superadmin/support/'+cur.id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qualification:g('spQual').value,note:g('spReply').value.trim().slice(0,200)})});await open_(cur.id);}catch(e){g('spMsg').innerHTML='<span class="error">'+esc(e.message)+'</span>';}}
async function reopen(){try{await api('/api/superadmin/support/'+cur.id+'/reopen',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await open_(cur.id);}catch(e){}}
async function meta(){try{await api('/api/superadmin/support/'+cur.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:g('spCat').value,priority:g('spPri').value})});loadList();}catch(e){}}
function init(){loadList();clearInterval(timer);timer=setInterval(()=>{if(document.hidden||g('areaSupport').classList.contains('hidden'))return;loadList();if(cur&&!(document.activeElement&&document.activeElement.id==='spReply'))open_(cur.id);},20000);}
function setFilter(f){filter=f;loadList();}
async function badgeOnly(){try{const r=await api('/api/superadmin/support?status=waiting');setBadge((r.counts||{}).waiting||0);}catch(e){}}
setInterval(()=>{if(!document.hidden&&g('app')&&!g('app').classList.contains('hidden')&&localStorage.getItem('vendia_superadmin_token'))badgeOnly();},60000);
window.VSp={init,open:open_,reply,resolve,reopen,meta,setFilter,loadList,badgeOnly};
})();

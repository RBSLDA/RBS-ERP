const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('pt-AO',{style:'currency',currency:'AOA'}).format(Number(n||0));
let areas=[],centers=[];
async function api(url,opt={}){
 const r=await fetch(url,{credentials:'include',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});
 if(r.status===401){location.href='/admin.html';return null}
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(data.error||'Operação não concluída');
 return data;
}
function setMsg(text,ok=true){const e=document.getElementById('msg');e.textContent=text;e.style.display=text?'block':'none';e.className='notice '+(ok?'':'bad')}
function areaOptions(selectId){
 const s=document.getElementById(selectId);s.innerHTML=areas.filter(a=>a.active!==false).map(a=>`<option value="${esc(a.code)}">${esc(a.name)}</option>`).join('');
}
function centerOptions(selectId,areaId){
 const s=document.getElementById(selectId),code=document.getElementById(areaId).value;
 s.innerHTML='<option value="">Sem centro de custo</option>'+centers.filter(c=>c.areaCode===code&&c.active!==false).map(c=>`<option value="${esc(c.id)}">${esc(c.code)} — ${esc(c.name)}</option>`).join('');
}
function renderSummary(x){
 const t=x.totals;
 document.getElementById('totals').innerHTML=[
  ['Receitas',money(t.revenue)],['Despesas',money(t.expenses)],['Resultado',money(t.result)],['Stock',money(t.stockValue)],['Quantidade em stock',t.stockQty]
 ].map(([a,b])=>`<div class="v17-card"><small>${a}</small><strong>${b}</strong></div>`).join('');
 document.getElementById('areaRows').innerHTML=x.areas.map(a=>`<tr><td><strong>${esc(a.name)}</strong><br><small>${esc(a.code)}</small></td><td>${money(a.revenue)}</td><td>${money(a.expenses)}</td><td class="${a.result>=0?'positive':'negative'}"><strong>${money(a.result)}</strong></td><td>${a.stockQty} un. · ${money(a.stockValue)}</td><td>${a.products}</td></tr>`).join('');
}
function renderCenters(){
 document.getElementById('ccRows').innerHTML=centers.length?centers.map(c=>`<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc((areas.find(a=>a.code===c.areaCode)||{}).name||c.areaCode)}</td><td>${c.active===false?'Inativo':'Ativo'}</td></tr>`).join(''):'<tr><td colspan="4">Sem centros de custo.</td></tr>';
}
async function load(){
 try{
  const [a,s,c,e]=await Promise.all([api('/api/areas'),api('/api/areas/summary'),api('/api/areas/cost-centers'),api('/api/areas/entries')]);
  areas=a||[];centers=c||[];renderSummary(s);renderCenters();
  ['entryArea','expenseArea','ccArea'].forEach(areaOptions);
  ['entryArea','expenseArea','ccArea'].forEach(id=>document.getElementById(id).addEventListener('change',()=>{const map={entryArea:'entryCC',expenseArea:'expenseCC'};if(map[id])centerOptions(map[id],id)}));
  centerOptions('entryCC','entryArea');centerOptions('expenseCC','expenseArea');
  const ex=await api('/api/areas/expenses');
  const rows=[...(e||[]).map(x=>({...x,_type:'Receita',_date:x.entryDate})),...(ex||[]).map(x=>({...x,_type:'Despesa',_date:x.expenseDate}))].sort((a,b)=>String(b._date).localeCompare(String(a._date))).slice(0,30);
  document.getElementById('movementRows').innerHTML=rows.length?rows.map(x=>`<tr><td>${x._type}</td><td>${esc((areas.find(a=>a.code===x.areaCode)||{}).name||x.areaCode)}</td><td>${esc(x.description)}</td><td class="${x._type==='Receita'?'positive':'negative'}">${money(x.amount)}</td><td>${esc(x._date||'')}</td></tr>`).join(''):'<tr><td colspan="5">Sem movimentações.</td></tr>';
 }catch(err){setMsg(err.message,false)}
}
document.getElementById('entryForm').addEventListener('submit',async e=>{
 e.preventDefault();try{await api('/api/areas/entries',{method:'POST',body:JSON.stringify({areaCode:entryArea.value,costCenterId:entryCC.value,description:entryDesc.value,amount:entryAmount.value,entryDate:entryDate.value})});e.target.reset();setMsg('Receita registada.');await load()}catch(err){setMsg(err.message,false)}
});
document.getElementById('expenseForm').addEventListener('submit',async e=>{
 e.preventDefault();try{await api('/api/areas/expenses',{method:'POST',body:JSON.stringify({areaCode:expenseArea.value,costCenterId:expenseCC.value,description:expenseDesc.value,category:expenseCategory.value,amount:expenseAmount.value,expenseDate:expenseDate.value})});e.target.reset();expenseCategory.value='Geral';setMsg('Despesa registada.');await load()}catch(err){setMsg(err.message,false)}
});
document.getElementById('ccForm').addEventListener('submit',async e=>{
 e.preventDefault();try{await api('/api/areas/cost-centers',{method:'POST',body:JSON.stringify({areaCode:ccArea.value,code:ccCode.value,name:ccName.value,description:ccDesc.value})});e.target.reset();setMsg('Centro de custo criado.');await load()}catch(err){setMsg(err.message,false)}
});
load();

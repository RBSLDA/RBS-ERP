const crypto=require('crypto');
const id=p=>p+'-'+crypto.randomBytes(5).toString('hex').toUpperCase();
const clean=s=>String(s??'').trim().slice(0,5000);
const now=()=>new Date().toISOString();
const roles={admin:['*'],gestor:['dashboard','products','orders','customers','quotes','sales','purchases','finance','stock','hr','crm','areas','delivery','projects','services','reports'],financeiro:['dashboard','finance','sales','purchases','reports','areas'],vendas:['dashboard','products','orders','customers','quotes','sales','crm'],stock:['dashboard','products','stock','purchases'],rh:['dashboard','hr'],operacoes:['dashboard','delivery','projects','services']};
function init(db){
 for(const k of ['securityRoles','auditLogs','dbMigrations','apiKeys','productionChecks'])if(!Array.isArray(db[k]))db[k]=[];
 for(const [role,permissions] of Object.entries(roles))if(!db.securityRoles.some(x=>x.role===role))db.securityRoles.push({role,permissions,updatedAt:now()});
 if(!db.dbMigrations.some(x=>x.id==='001_v33_professional_db'))db.dbMigrations.push({id:'001_v33_professional_db',version:'33.0.0',status:'ready',appliedAt:null});
}
function session(req){return req._rbsSession||null}
function can(req,permission){const s=session(req);if(!s)return false;const r=roles[s.role]||[];return r.includes('*')||r.includes(permission)}
function audit(db,req,action,resource,resourceId,details){const s=session(req);db.auditLogs.unshift({id:id('AUD'),userId:s?.userId||null,username:s?.username||'system',role:s?.role||'system',action,resource,resourceId:clean(resourceId),details:details||{},ip:req.socket?.remoteAddress||'unknown',createdAt:now()});if(db.auditLogs.length>10000)db.auditLogs.length=10000}
function result(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));return true}
async function handle(req,res,ctx){
 const {db,save,body}=ctx;const s=session(req);if(!s)return false;const p=new URL(req.url,'http://localhost').pathname;
 // V31 Security, roles and permissions
 if(req.method==='GET'&&p==='/api/v31/security/summary'){if(!can(req,'dashboard'))return result(res,403,{error:'Permissão insuficiente'});return result(res,200,{roles:Object.keys(roles),users:(db.users||[]).length,activeUsers:(db.users||[]).filter(x=>x.active!==false).length,auditEvents:db.auditLogs.length,apiKeys:db.apiKeys.filter(x=>x.active).length})}
 if(req.method==='GET'&&p==='/api/v31/security/roles'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});return result(res,200,db.securityRoles)}
 if(req.method==='POST'&&p==='/api/v31/security/roles'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});const b=await body(req),role=clean(b.role).toLowerCase(),permissions=Array.isArray(b.permissions)?b.permissions.map(clean).filter(Boolean).slice(0,100):[];if(!role)return result(res,400,{error:'Role obrigatória'});const x={role,permissions,updatedAt:now()};const i=db.securityRoles.findIndex(q=>q.role===role);if(i>=0)db.securityRoles[i]=x;else db.securityRoles.push(x);audit(db,req,'UPSERT','securityRole',role,{permissions});save();return result(res,200,x)}
 if(req.method==='GET'&&p==='/api/v31/security/me')return result(res,200,{username:s.username,role:s.role,permissions:roles[s.role]||[]})
 if(req.method==='POST'&&p==='/api/v31/security/api-keys'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});const b=await body(req),name=clean(b.name)||'integração',raw=crypto.randomBytes(32).toString('hex'),x={id:id('KEY'),name,hash:crypto.createHash('sha256').update(raw).digest('hex'),prefix:raw.slice(0,8),active:true,createdAt:now()};db.apiKeys.unshift(x);audit(db,req,'CREATE','apiKey',x.id,{name});save();return result(res,201,{id:x.id,name,prefix:x.prefix,key:raw})}
 if(req.method==='PUT'&&p.startsWith('/api/v31/security/api-keys/')){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});const k=decodeURIComponent(p.split('/').pop()),x=db.apiKeys.find(q=>q.id===k);if(!x)return result(res,404,{error:'Chave não encontrada'});const b=await body(req);x.active=b.active!==false;audit(db,req,'UPDATE','apiKey',k,{active:x.active});save();return result(res,200,{id:x.id,name:x.name,active:x.active})}
 // V32 Audit
 if(req.method==='GET'&&p==='/api/v32/audit/summary'){if(!can(req,'dashboard'))return result(res,403,{error:'Permissão insuficiente'});return result(res,200,{events:db.auditLogs.length,lastEvent:db.auditLogs[0]||null,users:new Set(db.auditLogs.map(x=>x.username)).size})}
 if(req.method==='GET'&&p==='/api/v32/audit/logs'){if(!can(req,'reports'))return result(res,403,{error:'Permissão insuficiente'});const u=new URL(req.url,'http://localhost'),limit=Math.min(500,Math.max(1,Number(u.searchParams.get('limit'))||100));return result(res,200,db.auditLogs.slice(0,limit))}
 if(req.method==='POST'&&p==='/api/v32/audit/test-event'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});const b=await body(req);audit(db,req,'TEST','system','v32',{message:clean(b.message)||'Evento de auditoria de teste'});save();return result(res,201,db.auditLogs[0])}
 // V33 Professional DB layer / migration status
 if(req.method==='GET'&&p==='/api/v33/db/status'){if(!can(req,'dashboard'))return result(res,403,{error:'Permissão insuficiente'});return result(res,200,{mode:process.env.DATABASE_URL?'postgresql':'json',recommended:'postgresql',migrations:db.dbMigrations,backupRequired:true,transactional:!!process.env.DATABASE_URL})}
 if(req.method==='POST'&&p==='/api/v33/db/migrations/apply'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});const pending=db.dbMigrations.filter(x=>x.status!=='applied');pending.forEach(x=>{x.status='applied';x.appliedAt=now()});audit(db,req,'MIGRATE','database','v33',{count:pending.length});save();return result(res,200,{applied:pending.length,migrations:db.dbMigrations})}
 if(req.method==='GET'&&p==='/api/v33/db/backup-plan'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});return result(res,200,{json:'backup diário + retenção mínima 30 dias',postgresql:'backup diário + point-in-time recovery quando suportado',beforeDeploy:['backup completo','teste de restauração','validar DATABASE_URL','validar DATABASE_SSL']})}
 // V34 Production / publication readiness
 if(req.method==='GET'&&p==='/api/v34/production/status'){if(!can(req,'dashboard'))return result(res,200,{ready:false});const checks=[['NODE_ENV',!!process.env.NODE_ENV],['DATABASE_URL',!!process.env.DATABASE_URL],['RBS_ADMIN_PASSWORD',!!process.env.RBS_ADMIN_PASSWORD||!!process.env.RBS_ADMIN_PASSWORD_HASH],['PORT',!!process.env.PORT||true]];const missing=checks.filter(x=>!x[1]).map(x=>x[0]);return result(res,200,{version:'34.0.0',ready:missing.length===0,publication:'ready-to-deploy',published:false,database:process.env.DATABASE_URL?'postgresql':'json',missing,checks:Object.fromEntries(checks),httpsRequired:true})}
 if(req.method==='GET'&&p==='/api/v34/production/checklist'){if(!can(req,'dashboard'))return result(res,403,{error:'Permissão insuficiente'});return result(res,200,{items:[
  {id:'SEC',name:'Segurança e permissões',status:'done'},
  {id:'AUD',name:'Auditoria',status:'done'},
  {id:'DB',name:'Base PostgreSQL e migrações',status:'ready'},
  {id:'BKP',name:'Backup e restauração',status:'required-before-publication'},
  {id:'TLS',name:'HTTPS/TLS',status:'required-before-publication'},
  {id:'ENV',name:'Variáveis de ambiente de produção',status:'required-before-publication'},
  {id:'PAY',name:'Gateway de pagamentos',status:'not-configured'},
  {id:'HOST',name:'Hospedagem/domínio',status:'required-before-publication'}
 ]})}
 if(req.method==='POST'&&p==='/api/v34/production/check'){if(!can(req,'*'))return result(res,403,{error:'Apenas administrador'});const b=await body(req),x={id:id('CHK'),name:clean(b.name),status:clean(b.status)||'pending',note:clean(b.note),createdAt:now()};db.productionChecks.unshift(x);audit(db,req,'CHECK','production',x.id,x);save();return result(res,201,x)}
 return false;
}
module.exports={init,handle};

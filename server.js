const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {URL}=require('url');
const {ensureFinance,recalcFinance,financeRoutes}=require('./finance-v16');
const future=require('./future-v20-v25');
const future2630=require('./future-v26-v30');
const future3134=require('./future-v31-v34');

const PORT=Number(process.env.PORT||3000);
const ROOT=__dirname, PUBLIC=path.join(ROOT,'public'), DATA=path.join(ROOT,'data'), DB=path.join(DATA,'rbs.json'), SEED=path.join(DATA,'seed.json');
const UPLOADS=path.join(PUBLIC,'uploads');
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(UPLOADS,{recursive:true});

let pg=null, pool=null;
try{pg=require('pg');}catch{}
if(process.env.DATABASE_URL&&pg){
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='false'?false:{rejectUnauthorized:false},max:10,idleTimeoutMillis:30000});
}

function cloneSeed(){try{return JSON.parse(fs.readFileSync(SEED,'utf8'))}catch{return []}}
function load(){try{return JSON.parse(fs.readFileSync(DB,'utf8'))}catch{return {products:cloneSeed(),orders:[],users:[]}}}
let db=load();
for(const x of db.products)if(x.stock===undefined)x.stock=0;
for(const k of ['products','orders','users','customers','quotes','stockMovements','suppliers','purchases','sales','expenses','cashMovements','documents','areas','areaEntries','areaExpenses','costCenters','employees','attendance','leaves','crmInteractions','crmTasks','crmDeals'])if(!Array.isArray(db[k]))db[k]=[];
if(!fs.existsSync(DB))fs.writeFileSync(DB,JSON.stringify(db,null,2));
ensureFinance(db);
future.init(db);
future2630.init(db);
future3134.init(db);
recalcFinance(db);

const sessions=new Map(), attempts=new Map();
const save=()=>fs.writeFileSync(DB,JSON.stringify(db,null,2));
const id=p=>p+'-'+crypto.randomBytes(6).toString('hex').toUpperCase();
const clean=s=>String(s??'').trim().slice(0,5000);
function normalizeItems(items){
  if(!Array.isArray(items)) return [];
  return items.slice(0,100).map(x=>({
    productId:clean(x.productId), name:clean(x.name||x.description),
    quantity:Math.max(0,Number(x.quantity)||0), unitPrice:Math.max(0,Number(x.unitPrice??x.price)||0),
    total:Math.max(0,Number(x.total)||((Number(x.quantity)||0)*(Number(x.unitPrice??x.price)||0)))
  })).filter(x=>x.productId&&x.quantity>0);
}
async function getProductsMap(){const ps=await productsAll();return new Map(ps.map(x=>[x.id,x]));}
async function applyStock(items, direction, note){
  const map=await getProductsMap();
  for(const it of items){const p=map.get(it.productId);if(!p)throw new Error('Produto não encontrado: '+it.productId);const qty=Number(it.quantity)||0;if(direction<0 && Number(p.stock||0)<qty)throw new Error('Stock insuficiente para '+p.name);}
  if(pool){
    const client=await pool.connect();
    try{await client.query('BEGIN');for(const it of items){const q=direction*Number(it.quantity);const m=id('MOV');const type=q>0?'Entrada':'Saída';await client.query('UPDATE products SET stock=GREATEST(0,COALESCE(stock,0)+$1),updated_at=$2 WHERE id=$3',[q,new Date().toISOString(),it.productId]);await client.query('INSERT INTO stock_movements(id,product_id,quantity,type,note,created_at) VALUES($1,$2,$3,$4,$5,$6)',[m,it.productId,q,type,note,new Date().toISOString()]);}await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }else{for(const it of items){const p=map.get(it.productId);p.stock=Math.max(0,(Number(p.stock)||0)+direction*Number(it.quantity));db.stockMovements.unshift({id:id('MOV'),productId:it.productId,quantity:direction*Number(it.quantity),type:direction>0?'Entrada':'Saída',note,createdAt:new Date().toISOString()})}save()}
}

const json=(res,status,data,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(JSON.stringify(data));};
const body=req=>new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>5e6){reject(new Error('Payload too large'));req.destroy()}});req.on('end',()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}})});
function clientKey(req){return req.socket.remoteAddress||'unknown'}
function parseCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
function session(req){const t=parseCookies(req).rbs_session;if(!t)return null;const s=sessions.get(t);if(!s)return null;if(s.expires<Date.now()){sessions.delete(t);return null}return s}
function auth(req){return !!session(req)}
function requireAdmin(req){return session(req)}
function passwordHash(value){const salt=crypto.randomBytes(16);const key=crypto.scryptSync(String(value),salt,32);return salt.toString('hex')+':'+key.toString('hex')}
function passwordOK(value,hash){try{const [saltHex,keyHex]=String(hash||'').split(':');const derived=crypto.scryptSync(String(value),Buffer.from(saltHex,'hex'),32);return crypto.timingSafeEqual(derived,Buffer.from(keyHex,'hex'))}catch{return false}}
const ENV_USER=process.env.RBS_ADMIN_USER||'admin';
const ENV_PASS=process.env.RBS_ADMIN_PASSWORD||'MUDAR_ESTA_SENHA';
const ENV_HASH=process.env.RBS_ADMIN_PASSWORD_HASH||'';
function localAdmin(){let u=db.users.find(x=>x.username===ENV_USER);if(!u){u={id:id('USR'),username:ENV_USER,passwordHash:ENV_HASH||passwordHash(ENV_PASS),role:'admin',active:true,createdAt:new Date().toISOString()};db.users.push(u);save()}return u}
localAdmin();
function customerInsert(x){if(!pool){db.customers.unshift(x);save();return Promise.resolve(x)}return pool.query('INSERT INTO customers(id,name,phone,email,company,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[x.id,x.name,x.phone,x.email,x.company,x.note,x.createdAt]).then(()=>x)}
async function customersAll(){if(!pool)return db.customers;const r=await pool.query('SELECT id,name,phone,email,company,note,created_at \"createdAt\" FROM customers ORDER BY created_at DESC');return r.rows}
async function quoteInsert(x){if(!pool){db.quotes.unshift(x);save();return x}await pool.query('INSERT INTO quotes(id,customer_id,items,total,status,created_at) VALUES($1,$2,$3,$4,$5,$6)',[x.id,x.customerId,JSON.stringify(x.items||[]),x.total,x.status,x.createdAt]);return x}
async function quotesAll(){if(!pool)return db.quotes;const r=await pool.query('SELECT id,customer_id \"customerId\",items,total,status,created_at \"createdAt\" FROM quotes ORDER BY created_at DESC');return r.rows.map(x=>({...x,items:typeof x.items==='string'?JSON.parse(x.items):x.items}))}

function docNumber(type){const year=new Date().getFullYear();const list=db.documents||[];const n=list.filter(x=>x.type===type && String(x.number||'').startsWith(type+'/'+year+'/')).length+1;return `${type}/${year}/${String(n).padStart(5,'0')}`;}
async function documentsAll(){if(!pool)return db.documents;const r=await pool.query('SELECT id,number,type,status,customer_id "customerId",items,total,notes,created_at "createdAt",updated_at "updatedAt" FROM documents ORDER BY created_at DESC');return r.rows.map(x=>({...x,items:typeof x.items==='string'?JSON.parse(x.items):x.items}));}
async function documentInsert(x){if(!pool){db.documents.unshift(x);save();return x}await pool.query('INSERT INTO documents(id,number,type,status,customer_id,items,total,notes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[x.id,x.number,x.type,x.status,x.customerId,JSON.stringify(x.items||[]),x.total,x.notes,x.createdAt,x.updatedAt]);return x;}

const AREA_DEFS=[
 {code:'MOTO',name:'RBS Moto',description:'Mototáxi, equipamentos, acessórios, motociclos, peças e oficina.',active:true},
 {code:'CONSTRUCAO',name:'RBS Construção',description:'Materiais, ferramentas, pedreira, canalização, elétrica, equipamentos e mobiliário.',active:true},
 {code:'FASHION',name:'RBS Fashion',description:'Moda, uniformes e personalização para homens, mulheres e crianças.',active:true},
 {code:'GRAFICA',name:'RBS Gráfica & Comunicação',description:'Impressão, gráfica, identidade visual, comunicação e redes sociais.',active:true},
 {code:'DIGITAL',name:'RBS Digital',description:'Web, catálogo digital, presença online e comunicação comercial.',active:true},
 {code:'SERVICOS',name:'RBS Prestação de Serviços',description:'TI, design, construção, canalização, elétrica, manutenção e serviços.',active:true},
 {code:'DELIVERY',name:'RBS Delivery',description:'Entrega, logística, distribuição e transporte de materiais.',active:true},
 {code:'START',name:'RBS Start',description:'Transformação de ideias de negócio em marcas prontas para começar.',active:true}
];
function normalizeAreaCode(v){
 const q=clean(v).toUpperCase();
 const aliases={'RBS MOTO':'MOTO','RBS CONSTRUÇÃO':'CONSTRUCAO','RBS CONSTRUCAO':'CONSTRUCAO','RBS FASHION':'FASHION','RBS GRÁFICA & COMUNICAÇÃO':'GRAFICA','RBS GRAFICA & COMUNICACAO':'GRAFICA','RBS DIGITAL':'DIGITAL','RBS PRESTAÇÃO DE SERVIÇOS':'SERVICOS','RBS PRESTACAO DE SERVICOS':'SERVICOS','RBS DELIVERY':'DELIVERY','RBS START':'START'};
 return AREA_DEFS.some(a=>a.code===q)?q:(aliases[q]||'');
}
function areaName(code){return AREA_DEFS.find(a=>a.code===code)?.name||code}
function productAreaCode(area){
 const n=clean(area).toUpperCase();
 return normalizeAreaCode(n);
}
async function areaEntriesAll(){
 if(!pool)return db.areaEntries;
 const r=await pool.query('SELECT id,area_code "areaCode",cost_center_id "costCenterId",description,amount,source_type "sourceType",source_id "sourceId",entry_date "entryDate",created_at "createdAt" FROM area_entries ORDER BY created_at DESC');
 return r.rows;
}
async function areaExpensesAll(){
 if(!pool)return db.areaExpenses;
 const r=await pool.query('SELECT id,area_code "areaCode",cost_center_id "costCenterId",description,amount,category,source_type "sourceType",source_id "sourceId",expense_date "expenseDate",created_at "createdAt" FROM area_expenses ORDER BY created_at DESC');
 return r.rows;
}
async function costCentersAll(){
 if(!pool)return db.costCenters;
 const r=await pool.query('SELECT id,area_code "areaCode",code,name,description,active,created_at "createdAt",updated_at "updatedAt" FROM cost_centers ORDER BY created_at DESC');
 return r.rows;
}
function ensureAreasLocal(){
 for(const a of AREA_DEFS)if(!db.areas.some(x=>x.code===a.code))db.areas.push({...a});
}
ensureAreasLocal();

async function pgInit(){if(!pool)return;await pool.query(`CREATE TABLE IF NOT EXISTS users(id text primary key,username text unique not null,password_hash text not null,role text not null default 'admin',active boolean not null default true,created_at timestamptz not null default now());CREATE TABLE IF NOT EXISTS products(id text primary key,name text not null,area text,category text,description text,price text,stock numeric default 0,status text,featured boolean default false,created_at timestamptz default now(),updated_at timestamptz);CREATE TABLE IF NOT EXISTS orders(id text primary key,name text not null,phone text not null,email text,area text,item text,message text,status text not null,created_at timestamptz default now(),updated_at timestamptz);CREATE TABLE IF NOT EXISTS customers(id text primary key,name text not null,phone text,email text,company text,note text,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS quotes(id text primary key,customer_id text,items jsonb not null default '[]',total numeric default 0,status text not null,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS documents(id text primary key,number text unique not null,type text not null,status text not null,customer_id text,items jsonb not null default '[]',total numeric default 0,notes text,created_at timestamptz default now(),updated_at timestamptz);CREATE TABLE IF NOT EXISTS suppliers(id text primary key,name text not null,phone text,email text,company text,note text,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS purchases(id text primary key,supplier_id text,items jsonb not null default '[]',total numeric default 0,status text not null,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS sales(id text primary key,customer_id text,items jsonb not null default '[]',total numeric default 0,status text not null,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS expenses(id text primary key,description text not null,category text,amount numeric not null,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS cash_movements(id text primary key,type text not null,description text,amount numeric not null,reference text,created_at timestamptz default now());CREATE TABLE IF NOT EXISTS stock_movements(id text primary key,product_id text not null,quantity numeric not null,type text not null,note text,created_at timestamptz default now());ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_status text not null default 'Pendente';ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_amount numeric not null default 0;ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status text not null default 'Pendente';ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_amount numeric not null default 0;CREATE TABLE IF NOT EXISTS areas(code text primary key,name text not null,description text,active boolean not null default true);
CREATE TABLE IF NOT EXISTS cost_centers(id text primary key,area_code text not null references areas(code),code text unique not null,name text not null,description text,active boolean not null default true,created_at timestamptz default now(),updated_at timestamptz);
CREATE TABLE IF NOT EXISTS area_entries(id text primary key,area_code text not null references areas(code),cost_center_id text,description text not null,amount numeric not null,source_type text,source_id text,entry_date date not null,created_at timestamptz default now());
CREATE TABLE IF NOT EXISTS area_expenses(id text primary key,area_code text not null references areas(code),cost_center_id text,description text not null,amount numeric not null,category text,source_type text,source_id text,expense_date date not null,created_at timestamptz default now());
CREATE TABLE IF NOT EXISTS employees(id text primary key,employee_code text unique not null,name text not null,phone text,email text,birth_date date,position text,department text,area_code text,admission_date date,contract_type text,salary numeric default 0,status text not null default 'Ativo',notes text,created_at timestamptz default now(),updated_at timestamptz);
CREATE TABLE IF NOT EXISTS attendance(id text primary key,employee_id text not null references employees(id),attendance_date date not null,status text not null,check_in text,check_out text,note text,created_at timestamptz default now(),updated_at timestamptz);
CREATE TABLE IF NOT EXISTS leaves(id text primary key,employee_id text not null references employees(id),leave_type text not null,start_date date not null,end_date date not null,status text not null default 'Pendente',reason text,created_at timestamptz default now(),updated_at timestamptz);
CREATE TABLE IF NOT EXISTS crm_interactions(id text primary key,customer_id text not null,interaction_type text not null,subject text not null,description text,interaction_date timestamptz not null default now(),next_action text,created_at timestamptz default now());
CREATE TABLE IF NOT EXISTS crm_tasks(id text primary key,customer_id text,deal_id text,title text not null,due_date date,status text not null default 'Pendente',priority text not null default 'Normal',notes text,created_at timestamptz default now(),updated_at timestamptz);
CREATE TABLE IF NOT EXISTS crm_deals(id text primary key,customer_id text not null,title text not null,area_code text,value numeric default 0,stage text not null default 'Novo',probability numeric default 0,expected_date date,notes text,created_at timestamptz default now(),updated_at timestamptz);

`);const c=await pool.query('SELECT COUNT(*)::int n FROM products');if(c.rows[0].n===0){for(const p of db.products){await pool.query('INSERT INTO products(id,name,area,category,description,price,stock,status,featured) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[p.id,p.name,p.area,p.category,p.description,p.price,p.stock,p.status,p.featured])}}const ac=await pool.query('SELECT COUNT(*)::int n FROM areas');
if(ac.rows[0].n===0){for(const a of AREA_DEFS)await pool.query('INSERT INTO areas(code,name,description,active) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[a.code,a.name,a.description,a.active]);}
}
async function productsAll(){if(!pool)return db.products;const r=await pool.query('SELECT id,name,area,category,description,price,stock,status,featured,created_at "createdAt",updated_at "updatedAt" FROM products ORDER BY created_at ASC');return r.rows}
async function ordersAll(){if(!pool)return db.orders;const r=await pool.query('SELECT id,name,phone,email,area,item,message,status,created_at "createdAt",updated_at "updatedAt" FROM orders ORDER BY created_at DESC');return r.rows}
async function productInsert(x){if(!pool){db.products.push(x);save();return x}await pool.query('INSERT INTO products(id,name,area,category,description,price,stock,status,featured,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[x.id,x.name,x.area,x.category,x.description,x.price,x.stock,x.status,x.featured,x.createdAt]);return x}
async function productUpdate(k,b,old){const x={...old,...b,id:k,name:clean(b.name||old.name),updatedAt:new Date().toISOString()};if(!pool){const i=db.products.findIndex(q=>q.id===k);db.products[i]=x;save();return x}await pool.query('UPDATE products SET name=$1,area=$2,category=$3,description=$4,price=$5,stock=$6,status=$7,featured=$8,updated_at=$9 WHERE id=$10',[x.name,x.area,x.category,x.description,x.price,x.stock,x.status,x.featured,x.updatedAt,k]);return x}
async function productDelete(k){if(!pool){const before=db.products.length;db.products=db.products.filter(x=>x.id!==k);save();return db.products.length<before}const r=await pool.query('DELETE FROM products WHERE id=$1', [k]);return r.rowCount>0}
async function orderInsert(o){if(!pool){db.orders.unshift(o);save();return o}await pool.query('INSERT INTO orders(id,name,phone,email,area,item,message,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[o.id,o.name,o.phone,o.email,o.area,o.item,o.message,o.status,o.createdAt]);return o}
async function orderUpdate(k,b,old){const x={...old,...b,id:k,updatedAt:new Date().toISOString()};if(!pool){const i=db.orders.findIndex(q=>q.id===k);db.orders[i]=x;save();return x}await pool.query('UPDATE orders SET status=$1,message=$2,updated_at=$3 WHERE id=$4',[x.status,x.message,x.updatedAt,k]);return x}
async function orderDelete(k){if(!pool){const before=db.orders.length;db.orders=db.orders.filter(x=>x.id!==k);save();return db.orders.length<before}const r=await pool.query('DELETE FROM orders WHERE id=$1',[k]);return r.rowCount>0}

async function crmInteractionsAll(customerId){
 if(!pool){let a=db.crmInteractions;return customerId?a.filter(x=>x.customerId===customerId):a}
 const q=customerId?'SELECT id,customer_id "customerId",interaction_type "interactionType",subject,description,interaction_date "interactionDate",next_action "nextAction",created_at "createdAt" FROM crm_interactions WHERE customer_id=$1 ORDER BY interaction_date DESC':'SELECT id,customer_id "customerId",interaction_type "interactionType",subject,description,interaction_date "interactionDate",next_action "nextAction",created_at "createdAt" FROM crm_interactions ORDER BY interaction_date DESC';
 const r=await pool.query(q,customerId?[customerId]:[]);return r.rows;
}
async function crmTasksAll(){
 if(!pool)return db.crmTasks;
 const r=await pool.query('SELECT id,customer_id "customerId",deal_id "dealId",title,due_date "dueDate",status,priority,notes,created_at "createdAt",updated_at "updatedAt" FROM crm_tasks ORDER BY due_date NULLS LAST,created_at DESC');return r.rows;
}
async function crmDealsAll(){
 if(!pool)return db.crmDeals;
 const r=await pool.query('SELECT id,customer_id "customerId",title,area_code "areaCode",value,stage,probability,expected_date "expectedDate",notes,created_at "createdAt",updated_at "updatedAt" FROM crm_deals ORDER BY created_at DESC');return r.rows;
}
function cleanSessions(){for(const[t,s]of sessions)if(s.expires<Date.now())sessions.delete(t)}setInterval(cleanSessions,60000).unref();
function requireSameOrigin(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===req.headers.host}catch{return false}}

async function api(req,res){
 const p=new URL(req.url,'http://localhost').pathname;
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':req.headers.origin||'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Credentials':'true'});return res.end()}
 if(!requireSameOrigin(req))return json(res,403,{error:'Origem não autorizada'});
 if(req.method==='POST'&&p==='/api/login'){
  const k=clientKey(req),a=attempts.get(k)||{n:0,at:0};if(a.n>=8&&Date.now()-a.at<15*60e3)return json(res,429,{error:'Muitas tentativas. Aguarde 15 minutos.'});
  const b=await body(req);let u=localAdmin();if(pool){const r=await pool.query('SELECT * FROM users WHERE username=$1 AND active=true',[clean(b.username)]);u=r.rows[0]||null}
  const ok=!!u&&clean(b.username)===(u.username||ENV_USER)&&passwordOK(b.password||'',u.password_hash||u.passwordHash||ENV_HASH||'');
  if(!ok){a.n++;a.at=Date.now();attempts.set(k,a);return json(res,401,{error:'Credenciais inválidas'})}
  attempts.delete(k);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{userId:u.id,username:u.username,role:u.role,expires:Date.now()+8*60*60e3});
  return json(res,200,{ok:true,user:{username:u.username,role:u.role},expiresIn:28800},{'Set-Cookie':`rbs_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`});
 }
 if(req.method==='POST'&&p==='/api/logout'){const t=parseCookies(req).rbs_session;if(t)sessions.delete(t);return json(res,200,{ok:true},{'Set-Cookie':'rbs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
 if(req.method==='GET'&&p==='/api/health')return json(res,200,{ok:true,service:'RBS Plataforma Comercial',version:'34.0.0',database:pool?'postgresql':'json',products:(await productsAll()).length,orders:(await ordersAll()).length});
 if(req.method==='GET'&&p==='/api/session'){const s=session(req);return json(res,200,{authenticated:!!s,user:s?{username:s.username,role:s.role}:null});}
 if(req.method==='GET'&&p==='/api/products'){const items=await productsAll();return json(res,200,items.filter(x=>x.status!=='Inativo'));}
 if(req.method==='GET'&&p==='/api/orders'){if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,200,await ordersAll());}
 if(req.method==='POST'&&p==='/api/orders'){const b=await body(req);if(!clean(b.name)||!clean(b.phone))return json(res,400,{error:'Nome e telefone são obrigatórios'});const o={id:id('PED'),name:clean(b.name),phone:clean(b.phone),email:clean(b.email),area:clean(b.area),item:clean(b.item),message:clean(b.message),status:'Novo',createdAt:new Date().toISOString()};await orderInsert(o);return json(res,201,o);}
 if(req.method==='POST'&&p==='/api/uploads'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req),m=String(b.data||'').match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);if(!m)return json(res,400,{error:'Envie uma imagem PNG, JPEG ou WebP em data URL'});const raw=Buffer.from(m[2],'base64');if(raw.length>4*1024*1024)return json(res,413,{error:'Imagem acima de 4 MB'});const ext=m[1].split('/')[1].replace('jpeg','jpg'),name=`${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;fs.writeFileSync(path.join(UPLOADS,name),raw);return json(res,201,{url:`/uploads/${name}`});}
 if(req.method==='POST'&&p==='/api/payments/checkout'){if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,501,{error:'Gateway de pagamento ainda não configurado',supported:['manual','multicaixa','gateway-externo']});}
 if(req.method==='POST'&&p==='/api/admin/users'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.username)||!clean(b.password))return json(res,400,{error:'Utilizador e palavra-passe são obrigatórios'});const u={id:id('USR'),username:clean(b.username),passwordHash:passwordHash(b.password),role:'admin',active:true,createdAt:new Date().toISOString()};if(pool){await pool.query('INSERT INTO users(id,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5)',[u.id,u.username,u.passwordHash,u.role,u.active]);}else{if(db.users.some(x=>x.username===u.username))return json(res,409,{error:'Utilizador já existe'});db.users.push(u);save()}return json(res,201,{id:u.id,username:u.username,role:u.role,active:true});}
 if(p==='/api/products'&&req.method==='POST'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.name))return json(res,400,{error:'Nome obrigatório'});const x={id:clean(b.id)||id('RBS'),name:clean(b.name),area:clean(b.area),category:clean(b.category),description:clean(b.description),price:clean(b.price)||'Sob consulta',stock:Number.isFinite(Number(b.stock))?Math.max(0,Number(b.stock)):0,status:clean(b.status)||'Ativo',featured:Boolean(b.featured),image:clean(b.image),createdAt:new Date().toISOString()};if((await productsAll()).some(q=>q.id===x.id))return json(res,409,{error:'Referência já existe'});await productInsert(x);return json(res,201,x);}
 if(p.startsWith('/api/products/')&&req.method==='PUT'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),items=await productsAll(),old=items.find(x=>x.id===k);if(!old)return json(res,404,{error:'Produto não encontrado'});const b=await body(req);return json(res,200,await productUpdate(k,b,old));}
 if(p.startsWith('/api/products/')&&req.method==='DELETE'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop());if(!(await productDelete(k)))return json(res,404,{error:'Produto não encontrado'});return json(res,200,{ok:true});}
 if(p.startsWith('/api/orders/')&&req.method==='PUT'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),items=await ordersAll(),old=items.find(x=>x.id===k);if(!old)return json(res,404,{error:'Pedido não encontrado'});const b=await body(req),allowed=['Novo','Em análise','Concluído','Cancelado'];if(b.status&&!allowed.includes(b.status))return json(res,400,{error:'Estado inválido'});return json(res,200,await orderUpdate(k,b,old));}
 if(p.startsWith('/api/orders/')&&req.method==='DELETE'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop());if(!(await orderDelete(k)))return json(res,404,{error:'Pedido não encontrado'});return json(res,200,{ok:true});}
 if(req.method==='GET'&&p==='/api/customers'){if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,200,await customersAll());}
 if(req.method==='POST'&&p==='/api/customers'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.name)||!clean(b.phone))return json(res,400,{error:'Nome e telefone são obrigatórios'});const c={id:id('CLI'),name:clean(b.name),phone:clean(b.phone),email:clean(b.email),company:clean(b.company),note:clean(b.note),createdAt:new Date().toISOString()};await customerInsert(c);return json(res,201,c);}

 if(req.method==='PUT'&&p.startsWith('/api/customers/')&&p!=='/api/customers/'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});
  const k=decodeURIComponent(p.split('/').pop()),list=await customersAll(),old=list.find(x=>x.id===k);if(!old)return json(res,404,{error:'Cliente não encontrado'});
  const b=await body(req),x={...old,name:clean(b.name||old.name),phone:clean(b.phone||old.phone),email:clean(b.email??old.email),company:clean(b.company??old.company),note:clean(b.note??old.note)};
  if(pool)await pool.query('UPDATE customers SET name=$1,phone=$2,email=$3,company=$4,note=$5 WHERE id=$6',[x.name,x.phone,x.email,x.company,x.note,k]);else{const i=db.customers.findIndex(q=>q.id===k);db.customers[i]=x;save()}return json(res,200,x);
 }
 if(req.method==='GET'&&p==='/api/crm/dashboard'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});
  const [cs,ints,tasks,deals]=await Promise.all([customersAll(),crmInteractionsAll(),crmTasksAll(),crmDealsAll()]);
  const stages={};for(const d of deals)stages[d.stage]=(stages[d.stage]||0)+1;
  const pipeline=deals.reduce((n,d)=>n+Number(d.value||0),0),weighted=deals.reduce((n,d)=>n+Number(d.value||0)*Number(d.probability||0)/100,0);
  return json(res,200,{customers:cs.length,interactions:ints.length,tasks:tasks.length,pendingTasks:tasks.filter(x=>x.status!=='Concluída').length,deals:deals.length,pipeline,weightedPipeline:weighted,stages});
 }
 if(req.method==='GET'&&p==='/api/crm/interactions'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});const u=new URL(req.url,'http://localhost'),cid=clean(u.searchParams.get('customerId'));return json(res,200,await crmInteractionsAll(cid||null));
 }
 if(req.method==='POST'&&p==='/api/crm/interactions'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.customerId)||!clean(b.subject))return json(res,400,{error:'Cliente e assunto são obrigatórios'});
  const x={id:id('INT'),customerId:clean(b.customerId),interactionType:clean(b.interactionType)||'Nota',subject:clean(b.subject),description:clean(b.description),interactionDate:clean(b.interactionDate)||new Date().toISOString(),nextAction:clean(b.nextAction),createdAt:new Date().toISOString()};
  if(pool)await pool.query('INSERT INTO crm_interactions(id,customer_id,interaction_type,subject,description,interaction_date,next_action,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.id,x.customerId,x.interactionType,x.subject,x.description,x.interactionDate,x.nextAction,x.createdAt]);else{db.crmInteractions.unshift(x);save()}return json(res,201,x);
 }
 if(req.method==='GET'&&p==='/api/crm/tasks'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,200,await crmTasksAll());
 }
 if(req.method==='POST'&&p==='/api/crm/tasks'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.title))return json(res,400,{error:'Título obrigatório'});
  const x={id:id('TSK'),customerId:clean(b.customerId),dealId:clean(b.dealId),title:clean(b.title),dueDate:clean(b.dueDate)||null,status:clean(b.status)||'Pendente',priority:clean(b.priority)||'Normal',notes:clean(b.notes),createdAt:new Date().toISOString()};
  if(pool)await pool.query('INSERT INTO crm_tasks(id,customer_id,deal_id,title,due_date,status,priority,notes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.id,x.customerId||null,x.dealId||null,x.title,x.dueDate,x.status,x.priority,x.notes,x.createdAt]);else{db.crmTasks.unshift(x);save()}return json(res,201,x);
 }
 if(req.method==='PUT'&&p.startsWith('/api/crm/tasks/')){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),list=await crmTasksAll(),old=list.find(x=>x.id===k);if(!old)return json(res,404,{error:'Tarefa não encontrada'});const b=await body(req),x={...old,...b,id:k,updatedAt:new Date().toISOString()};
  if(pool)await pool.query('UPDATE crm_tasks SET status=$1,priority=$2,title=$3,due_date=$4,notes=$5,updated_at=$6 WHERE id=$7',[x.status,x.priority,x.title,x.dueDate||null,x.notes,x.updatedAt,k]);else{const i=db.crmTasks.findIndex(q=>q.id===k);db.crmTasks[i]=x;save()}return json(res,200,x);
 }
 if(req.method==='GET'&&p==='/api/crm/deals'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,200,await crmDealsAll());
 }
 if(req.method==='POST'&&p==='/api/crm/deals'){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.customerId)||!clean(b.title))return json(res,400,{error:'Cliente e título são obrigatórios'});
  const x={id:id('NEG'),customerId:clean(b.customerId),title:clean(b.title),areaCode:normalizeAreaCode(b.areaCode),value:Math.max(0,Number(b.value)||0),stage:clean(b.stage)||'Novo',probability:Math.min(100,Math.max(0,Number(b.probability)||0)),expectedDate:clean(b.expectedDate)||null,notes:clean(b.notes),createdAt:new Date().toISOString()};
  if(pool)await pool.query('INSERT INTO crm_deals(id,customer_id,title,area_code,value,stage,probability,expected_date,notes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[x.id,x.customerId,x.title,x.areaCode||null,x.value,x.stage,x.probability,x.expectedDate,x.notes,x.createdAt]);else{db.crmDeals.unshift(x);save()}return json(res,201,x);
 }
 if(req.method==='PUT'&&p.startsWith('/api/crm/deals/')){
  if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),list=await crmDealsAll(),old=list.find(x=>x.id===k);if(!old)return json(res,404,{error:'Negócio não encontrado'});const b=await body(req),x={...old,...b,id:k,updatedAt:new Date().toISOString(),value:Math.max(0,Number(b.value??old.value)||0),probability:Math.min(100,Math.max(0,Number(b.probability??old.probability)||0))};
  if(pool)await pool.query('UPDATE crm_deals SET title=$1,area_code=$2,value=$3,stage=$4,probability=$5,expected_date=$6,notes=$7,updated_at=$8 WHERE id=$9',[x.title,normalizeAreaCode(x.areaCode)||null,x.value,x.stage,x.probability,x.expectedDate||null,x.notes,x.updatedAt,k]);else{const i=db.crmDeals.findIndex(q=>q.id===k);db.crmDeals[i]=x;save()}return json(res,200,x);
 }
 if(req.method==='GET'&&p==='/api/quotes'){if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,200,await quotesAll());}
 if(req.method==='POST'&&p==='/api/quotes'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);const q={id:id('ORC'),customerId:clean(b.customerId),items:Array.isArray(b.items)?b.items.slice(0,100):[],total:Number(b.total||0),status:'Rascunho',createdAt:new Date().toISOString()};await quoteInsert(q);return json(res,201,q);}
 if(req.method==='GET'&&p==='/api/stock-movements'){if(!auth(req))return json(res,401,{error:'Não autorizado'});if(pool){const r=await pool.query('SELECT id,product_id \"productId\",quantity,type,note,created_at \"createdAt\" FROM stock_movements ORDER BY created_at DESC');return json(res,200,r.rows)}return json(res,200,db.stockMovements)}
 if(req.method==='POST'&&p==='/api/stock-movements'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);const productId=clean(b.productId),quantity=Number(b.quantity);if(!productId||!Number.isFinite(quantity)||quantity===0)return json(res,400,{error:'Produto e quantidade válida são obrigatórios'});const type=quantity>0?'Entrada':'Saída',m={id:id('MOV'),productId,quantity,type,note:clean(b.note),createdAt:new Date().toISOString()};if(pool){await pool.query('INSERT INTO stock_movements(id,product_id,quantity,type,note,created_at) VALUES($1,$2,$3,$4,$5,$6)',[m.id,m.productId,m.quantity,m.type,m.note,m.createdAt]);const r=await pool.query('UPDATE products SET stock=GREATEST(0,COALESCE(stock,0)+$1),updated_at=$2 WHERE id=$3 RETURNING id,stock',[quantity,m.createdAt,productId]);if(!r.rowCount)return json(res,404,{error:'Produto não encontrado'})}else{const prod=db.products.find(x=>x.id===productId);if(!prod)return json(res,404,{error:'Produto não encontrado'});prod.stock=Math.max(0,(Number(prod.stock)||0)+quantity);db.stockMovements.unshift(m);save()}return json(res,201,m);}

 if(req.method==='GET'&&p==='/api/suppliers'){if(!auth(req))return json(res,401,{error:'Não autorizado'});if(pool){const r=await pool.query('SELECT id,name,phone,email,company,note,created_at "createdAt" FROM suppliers ORDER BY created_at DESC');return json(res,200,r.rows)}return json(res,200,db.suppliers)}
 if(req.method==='POST'&&p==='/api/suppliers'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);if(!clean(b.name)||!clean(b.phone))return json(res,400,{error:'Nome e telefone são obrigatórios'});const x={id:id('FOR'),name:clean(b.name),phone:clean(b.phone),email:clean(b.email),company:clean(b.company),note:clean(b.note),createdAt:new Date().toISOString()};if(pool)await pool.query('INSERT INTO suppliers(id,name,phone,email,company,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[x.id,x.name,x.phone,x.email,x.company,x.note,x.createdAt]);else{db.suppliers.unshift(x);save()}return json(res,201,x)}
 if(req.method==='GET'&&p==='/api/purchases'){if(!auth(req))return json(res,401,{error:'Não autorizado'});if(pool){const r=await pool.query('SELECT id,supplier_id "supplierId",items,total,status,payment_status "paymentStatus",paid_amount "paidAmount",created_at "createdAt" FROM purchases ORDER BY created_at DESC');return json(res,200,r.rows.map(x=>({...x,items:typeof x.items==='string'?JSON.parse(x.items):x.items})))}return json(res,200,db.purchases)}
 if(req.method==='POST'&&p==='/api/purchases'){if(!auth(req))return json(res,401,{error:'Não autorizado'});try{const b=await body(req),items=normalizeItems(b.items),total=Number(b.total)||items.reduce((n,i)=>n+i.total,0);if(!items.length)return json(res,400,{error:'Adicione pelo menos um produto'});const x={id:id('CMP'),supplierId:clean(b.supplierId),items,total,status:clean(b.status)||'Recebida',paymentStatus:clean(b.paymentStatus)||'Pendente',paidAmount:Math.max(0,Number(b.paidAmount)||0),createdAt:new Date().toISOString()};if(x.status==='Recebida')await applyStock(items,1,'Compra '+x.id);if(pool)await pool.query('INSERT INTO purchases(id,supplier_id,items,total,status,payment_status,paid_amount,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.id,x.supplierId,JSON.stringify(x.items),x.total,x.status,x.paymentStatus,x.paidAmount,x.createdAt]);else{db.purchases.unshift(x);save()}if(x.paidAmount>0){const cm={id:id('CX'),type:'Saída',description:'Pagamento de compra '+x.id,amount:x.paidAmount,reference:x.id,createdAt:new Date().toISOString()};if(pool)await pool.query('INSERT INTO cash_movements(id,type,description,amount,reference,created_at) VALUES($1,$2,$3,$4,$5,$6)',[cm.id,cm.type,cm.description,cm.amount,cm.reference,cm.createdAt]);else{db.cashMovements.unshift(cm);save()}}return json(res,201,x)}catch(e){return json(res,400,{error:e.message||'Compra inválida'})}}
 if(req.method==='GET'&&p==='/api/sales'){if(!auth(req))return json(res,401,{error:'Não autorizado'});if(pool){const r=await pool.query('SELECT id,customer_id "customerId",items,total,status,payment_status "paymentStatus",paid_amount "paidAmount",created_at "createdAt" FROM sales ORDER BY created_at DESC');return json(res,200,r.rows.map(x=>({...x,items:typeof x.items==='string'?JSON.parse(x.items):x.items})))}return json(res,200,db.sales)}
 if(req.method==='POST'&&p==='/api/sales'){if(!auth(req))return json(res,401,{error:'Não autorizado'});try{const b=await body(req),items=normalizeItems(b.items),total=Number(b.total)||items.reduce((n,i)=>n+i.total,0);if(!items.length)return json(res,400,{error:'Adicione pelo menos um produto'});const x={id:id('VEN'),customerId:clean(b.customerId),items,total,status:clean(b.status)||'Concluída',paymentStatus:clean(b.paymentStatus)||'Pendente',paidAmount:Math.max(0,Number(b.paidAmount)||0),createdAt:new Date().toISOString()};if(x.status==='Concluída')await applyStock(items,-1,'Venda '+x.id);if(pool)await pool.query('INSERT INTO sales(id,customer_id,items,total,status,payment_status,paid_amount,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.id,x.customerId,JSON.stringify(x.items),x.total,x.status,x.paymentStatus,x.paidAmount,x.createdAt]);else{db.sales.unshift(x);save()}if(x.paidAmount>0){const cm={id:id('CX'),type:'Entrada',description:'Recebimento de venda '+x.id,amount:x.paidAmount,reference:x.id,createdAt:new Date().toISOString()};if(pool)await pool.query('INSERT INTO cash_movements(id,type,description,amount,reference,created_at) VALUES($1,$2,$3,$4,$5,$6)',[cm.id,cm.type,cm.description,cm.amount,cm.reference,cm.createdAt]);else{db.cashMovements.unshift(cm);save()}}return json(res,201,x)}catch(e){return json(res,400,{error:e.message||'Venda inválida'})}}
 if(req.method==='GET'&&p==='/api/expenses'){if(!auth(req))return json(res,401,{error:'Não autorizado'});if(pool){const r=await pool.query('SELECT id,description,category,amount,created_at "createdAt" FROM expenses ORDER BY created_at DESC');return json(res,200,r.rows)}return json(res,200,db.expenses)}
 if(req.method==='POST'&&p==='/api/expenses'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);const amount=Number(b.amount);if(!clean(b.description)||!Number.isFinite(amount)||amount<=0)return json(res,400,{error:'Descrição e valor positivo são obrigatórios'});const x={id:id('DES'),description:clean(b.description),category:clean(b.category)||'Geral',amount,createdAt:new Date().toISOString()};if(pool)await pool.query('INSERT INTO expenses(id,description,category,amount,created_at) VALUES($1,$2,$3,$4,$5)',[x.id,x.description,x.category,x.amount,x.createdAt]);else{db.expenses.unshift(x);save()}return json(res,201,x)}
 if(req.method==='GET'&&p==='/api/cash'){if(!auth(req))return json(res,401,{error:'Não autorizado'});if(pool){const r=await pool.query('SELECT id,type,description,amount,reference,created_at "createdAt" FROM cash_movements ORDER BY created_at DESC');return json(res,200,r.rows)}return json(res,200,db.cashMovements)}
 if(req.method==='POST'&&p==='/api/cash'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);const amount=Number(b.amount);if(!['Entrada','Saída'].includes(b.type)||!Number.isFinite(amount)||amount<=0)return json(res,400,{error:'Tipo e valor positivo são obrigatórios'});const x={id:id('CX'),type:b.type,description:clean(b.description),amount,reference:clean(b.reference),createdAt:new Date().toISOString()};if(pool)await pool.query('INSERT INTO cash_movements(id,type,description,amount,reference,created_at) VALUES($1,$2,$3,$4,$5,$6)',[x.id,x.type,x.description,x.amount,x.reference,x.createdAt]);else{db.cashMovements.unshift(x);save()}return json(res,201,x)}
 if(req.method==='GET'&&p==='/api/documents'){if(!auth(req))return json(res,401,{error:'Não autorizado'});return json(res,200,await documentsAll());}
 if(req.method==='POST'&&p==='/api/documents'){if(!auth(req))return json(res,401,{error:'Não autorizado'});try{const b=await body(req),type=clean(b.type).toUpperCase();if(!['ORC','PRO','FAT','REC'].includes(type))return json(res,400,{error:'Tipo de documento inválido'});const items=normalizeItems(b.items);if(!items.length)return json(res,400,{error:'Adicione pelo menos um produto/serviço'});const total=Number(b.total)||items.reduce((n,i)=>n+i.total,0);const x={id:id('DOC'),number:pool?`${type}/${new Date().getFullYear()}/${crypto.randomBytes(3).toString('hex').toUpperCase()}`:docNumber(type),type,status:clean(b.status)||({ORC:'Rascunho',PRO:'Emitida',FAT:'Emitida',REC:'Pago'}[type]),customerId:clean(b.customerId),items,total,notes:clean(b.notes),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await documentInsert(x);return json(res,201,x)}catch(e){return json(res,400,{error:e.message||'Documento inválido'})}}
 if(req.method==='PUT'&&p.startsWith('/api/documents/')){if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),docs=await documentsAll(),old=docs.find(x=>x.id===k);if(!old)return json(res,404,{error:'Documento não encontrado'});const b=await body(req),allowed={ORC:['Rascunho','Enviado','Aprovado','Cancelado'],PRO:['Emitida','Cancelada'],FAT:['Emitida','Paga','Cancelada'],REC:['Pago','Cancelado']}[old.type];if(b.status&&(!allowed||!allowed.includes(b.status)))return json(res,400,{error:'Estado inválido'});if(pool){const r=await pool.query('UPDATE documents SET status=COALESCE($1,status),notes=COALESCE($2,notes),updated_at=$3 WHERE id=$4 RETURNING id,number,type,status,customer_id "customerId",items,total,notes,created_at "createdAt",updated_at "updatedAt"',[clean(b.status)||null,clean(b.notes)||null,new Date().toISOString(),k]);const x=r.rows[0];if(x.items&&typeof x.items==='string')x.items=JSON.parse(x.items);return json(res,200,x)}const x={...old};if(b.status)x.status=clean(b.status);if(b.notes!==undefined)x.notes=clean(b.notes);x.updatedAt=new Date().toISOString();const i=db.documents.findIndex(d=>d.id===k);db.documents[i]=x;save();return json(res,200,x);}

 if(req.method==='GET'&&p==='/api/areas'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   if(pool){const r=await pool.query('SELECT code,name,description,active FROM areas ORDER BY name');return json(res,200,r.rows)}
   return json(res,200,db.areas);
 }
 if(req.method==='GET'&&p==='/api/areas/entries'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   return json(res,200,await areaEntriesAll());
 }
 if(req.method==='GET'&&p==='/api/areas/expenses'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   return json(res,200,await areaExpensesAll());
 }
 if(req.method==='GET'&&p==='/api/areas/cost-centers'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   return json(res,200,await costCentersAll());
 }
 if(req.method==='GET'&&p==='/api/areas/summary'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   const [areas,entries,expenses,products]=await Promise.all([pool?pool.query('SELECT code,name,description,active FROM areas ORDER BY name').then(r=>r.rows):Promise.resolve(db.areas),areaEntriesAll(),areaExpensesAll(),productsAll()]);
   const rows=areas.map(a=>{
     const rev=entries.filter(x=>x.areaCode===a.code).reduce((n,x)=>n+Number(x.amount||0),0);
     const exp=expenses.filter(x=>x.areaCode===a.code).reduce((n,x)=>n+Number(x.amount||0),0);
     const ps=products.filter(x=>productAreaCode(x.area)===a.code);
     const stockQty=ps.reduce((n,x)=>n+Number(x.stock||0),0);
     const stockValue=ps.reduce((n,x)=>n+(Number(x.stock)||0)*(Number(String(x.price||'').replace(/[^0-9.,]/g,'').replace(',','.'))||0),0);
     return {...a,revenue:rev,expenses:exp,result:rev-exp,stockQty,stockValue,products:ps.length};
   });
   const totalRevenue=rows.reduce((n,x)=>n+x.revenue,0),totalExpenses=rows.reduce((n,x)=>n+x.expenses,0);
   return json(res,200,{areas:rows,totals:{revenue:totalRevenue,expenses:totalExpenses,result:totalRevenue-totalExpenses,stockQty:rows.reduce((n,x)=>n+x.stockQty,0),stockValue:rows.reduce((n,x)=>n+x.stockValue,0)}});
 }
 if(req.method==='POST'&&p==='/api/areas/entries'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   const b=await body(req),areaCode=normalizeAreaCode(b.areaCode||b.area),amount=Number(b.amount);
   if(!areaCode||!Number.isFinite(amount)||amount<=0||!clean(b.description))return json(res,400,{error:'Área, descrição e valor positivo são obrigatórios'});
   const date=clean(b.entryDate)||new Date().toISOString().slice(0,10);
   const x={id:id('AREC'),areaCode,costCenterId:clean(b.costCenterId)||null,description:clean(b.description),amount,sourceType:clean(b.sourceType),sourceId:clean(b.sourceId),entryDate:date,createdAt:new Date().toISOString()};
   if(pool)await pool.query('INSERT INTO area_entries(id,area_code,cost_center_id,description,amount,source_type,source_id,entry_date,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.id,x.areaCode,x.costCenterId,x.description,x.amount,x.sourceType,x.sourceId,x.entryDate,x.createdAt]);
   else{db.areaEntries.unshift(x);save()}
   return json(res,201,x);
 }
 if(req.method==='POST'&&p==='/api/areas/expenses'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   const b=await body(req),areaCode=normalizeAreaCode(b.areaCode||b.area),amount=Number(b.amount);
   if(!areaCode||!Number.isFinite(amount)||amount<=0||!clean(b.description))return json(res,400,{error:'Área, descrição e valor positivo são obrigatórios'});
   const date=clean(b.expenseDate)||new Date().toISOString().slice(0,10);
   const x={id:id('ARDE'),areaCode,costCenterId:clean(b.costCenterId)||null,description:clean(b.description),amount,category:clean(b.category)||'Geral',sourceType:clean(b.sourceType),sourceId:clean(b.sourceId),expenseDate:date,createdAt:new Date().toISOString()};
   if(pool)await pool.query('INSERT INTO area_expenses(id,area_code,cost_center_id,description,amount,category,source_type,source_id,expense_date,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[x.id,x.areaCode,x.costCenterId,x.description,x.amount,x.category,x.sourceType,x.sourceId,x.expenseDate,x.createdAt]);
   else{db.areaExpenses.unshift(x);save()}
   return json(res,201,x);
 }
 if(req.method==='POST'&&p==='/api/areas/cost-centers'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   const b=await body(req),areaCode=normalizeAreaCode(b.areaCode||b.area);
   if(!areaCode||!clean(b.code)||!clean(b.name))return json(res,400,{error:'Área, código e nome são obrigatórios'});
   const x={id:id('CC'),areaCode,code:clean(b.code).toUpperCase(),name:clean(b.name),description:clean(b.description),active:b.active!==false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   if(pool)await pool.query('INSERT INTO cost_centers(id,area_code,code,name,description,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.id,x.areaCode,x.code,x.name,x.description,x.active,x.createdAt,x.updatedAt]);
   else{if(db.costCenters.some(c=>c.code===x.code))return json(res,409,{error:'Código do centro de custo já existe'});db.costCenters.unshift(x);save()}
   return json(res,201,x);
 }
 if(req.method==='PUT'&&p.startsWith('/api/areas/')&&p.split('/').length===4){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   const code=normalizeAreaCode(decodeURIComponent(p.split('/').pop()));if(!code)return json(res,404,{error:'Área não encontrada'});
   const b=await body(req),name=clean(b.name),description=clean(b.description);
   if(pool){const r=await pool.query('UPDATE areas SET name=COALESCE($1,name),description=COALESCE($2,description),active=COALESCE($3,active) WHERE code=$4 RETURNING code,name,description,active',[name||null,description||null,b.active===undefined?null:Boolean(b.active),code]);if(!r.rowCount)return json(res,404,{error:'Área não encontrada'});return json(res,200,r.rows[0])}
   const a=db.areas.find(x=>x.code===code);if(!a)return json(res,404,{error:'Área não encontrada'});if(name)a.name=name;if(description)a.description=description;if(b.active!==undefined)a.active=Boolean(b.active);save();return json(res,200,a);
 }


 // V18 — Recursos Humanos
 if(req.method==='GET'&&p==='/api/hr/employees'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   if(pool){const r=await pool.query(`SELECT id,employee_code "employeeCode",name,phone,email,birth_date "birthDate",position,department,area_code "areaCode",admission_date "admissionDate",contract_type "contractType",salary,status,notes,created_at "createdAt",updated_at "updatedAt" FROM employees ORDER BY created_at DESC`);return json(res,200,r.rows)}
   return json(res,200,db.employees);
 }
 if(req.method==='POST'&&p==='/api/hr/employees'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req);
   const name=clean(b.name), code=clean(b.employeeCode).toUpperCase();
   if(!name||!code)return json(res,400,{error:'Nome e código do funcionário são obrigatórios'});
   const exists=pool?await pool.query('SELECT 1 FROM employees WHERE employee_code=$1',[code]):{rowCount:db.employees.some(x=>x.employeeCode===code)?1:0};
   if(exists.rowCount)return json(res,409,{error:'Código do funcionário já existe'});
   const x={id:id('FUN'),employeeCode:code,name,phone:clean(b.phone),email:clean(b.email),birthDate:clean(b.birthDate)||null,position:clean(b.position),department:clean(b.department),areaCode:clean(b.areaCode),admissionDate:clean(b.admissionDate)||null,contractType:clean(b.contractType)||'Indeterminado',salary:Math.max(0,Number(b.salary)||0),status:clean(b.status)||'Ativo',notes:clean(b.notes),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   if(pool)await pool.query('INSERT INTO employees(id,employee_code,name,phone,email,birth_date,position,department,area_code,admission_date,contract_type,salary,status,notes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[x.id,x.employeeCode,x.name,x.phone,x.email,x.birthDate,x.position,x.department,x.areaCode,x.admissionDate,x.contractType,x.salary,x.status,x.notes,x.createdAt,x.updatedAt]);
   else{db.employees.unshift(x);save()}
   return json(res,201,x);
 }
 if(req.method==='PUT'&&p.startsWith('/api/hr/employees/')&&p.split('/').length===5){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),b=await body(req);
   if(pool){const r=await pool.query(`UPDATE employees SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=COALESCE($3,email),birth_date=COALESCE($4,birth_date),position=COALESCE($5,position),department=COALESCE($6,department),area_code=COALESCE($7,area_code),admission_date=COALESCE($8,admission_date),contract_type=COALESCE($9,contract_type),salary=COALESCE($10,salary),status=COALESCE($11,status),notes=COALESCE($12,notes),updated_at=$13 WHERE id=$14 RETURNING id,employee_code "employeeCode",name,phone,email,birth_date "birthDate",position,department,area_code "areaCode",admission_date "admissionDate",contract_type "contractType",salary,status,notes,created_at "createdAt",updated_at "updatedAt"`,[clean(b.name)||null,clean(b.phone)||null,clean(b.email)||null,clean(b.birthDate)||null,clean(b.position)||null,clean(b.department)||null,clean(b.areaCode)||null,clean(b.admissionDate)||null,clean(b.contractType)||null,b.salary===undefined?null:Math.max(0,Number(b.salary)||0),clean(b.status)||null,clean(b.notes)||null,new Date().toISOString(),k]);if(!r.rowCount)return json(res,404,{error:'Funcionário não encontrado'});return json(res,200,r.rows[0])}
   const i=db.employees.findIndex(x=>x.id===k);if(i<0)return json(res,404,{error:'Funcionário não encontrado'});const x={...db.employees[i]};for(const f of ['name','phone','email','birthDate','position','department','areaCode','admissionDate','contractType','status','notes'])if(b[f]!==undefined)x[f]=clean(b[f]);if(b.salary!==undefined)x.salary=Math.max(0,Number(b.salary)||0);x.updatedAt=new Date().toISOString();db.employees[i]=x;save();return json(res,200,x);
 }
 if(req.method==='DELETE'&&p.startsWith('/api/hr/employees/')&&p.split('/').length===5){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop());
   if(pool){const r=await pool.query("UPDATE employees SET status='Inativo',updated_at=$1 WHERE id=$2 RETURNING id",[new Date().toISOString(),k]);if(!r.rowCount)return json(res,404,{error:'Funcionário não encontrado'})}
   else{const x=db.employees.find(q=>q.id===k);if(!x)return json(res,404,{error:'Funcionário não encontrado'});x.status='Inativo';x.updatedAt=new Date().toISOString();save()}
   return json(res,200,{ok:true});
 }
 if(req.method==='GET'&&p==='/api/hr/attendance'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   if(pool){const r=await pool.query(`SELECT id,employee_id "employeeId",attendance_date "attendanceDate",status,check_in "checkIn",check_out "checkOut",note,created_at "createdAt",updated_at "updatedAt" FROM attendance ORDER BY attendance_date DESC,created_at DESC`);return json(res,200,r.rows)}
   return json(res,200,db.attendance);
 }
 if(req.method==='POST'&&p==='/api/hr/attendance'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req),employeeId=clean(b.employeeId),date=clean(b.attendanceDate)||new Date().toISOString().slice(0,10),status=clean(b.status)||'Presente';
   const valid=['Presente','Ausente','Atrasado','Férias','Folga'];if(!employeeId||!valid.includes(status))return json(res,400,{error:'Funcionário e estado válido são obrigatórios'});
   const x={id:id('ASS'),employeeId,attendanceDate:date,status,checkIn:clean(b.checkIn),checkOut:clean(b.checkOut),note:clean(b.note),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   if(pool)await pool.query('INSERT INTO attendance(id,employee_id,attendance_date,status,check_in,check_out,note,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.id,x.employeeId,x.attendanceDate,x.status,x.checkIn,x.checkOut,x.note,x.createdAt,x.updatedAt]);else{db.attendance.unshift(x);save()}
   return json(res,201,x);
 }
 if(req.method==='GET'&&p==='/api/hr/leaves'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});
   if(pool){const r=await pool.query(`SELECT id,employee_id "employeeId",leave_type "leaveType",start_date "startDate",end_date "endDate",status,reason,created_at "createdAt",updated_at "updatedAt" FROM leaves ORDER BY start_date DESC`);return json(res,200,r.rows)}return json(res,200,db.leaves);
 }
 if(req.method==='POST'&&p==='/api/hr/leaves'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const b=await body(req),employeeId=clean(b.employeeId),start=clean(b.startDate),end=clean(b.endDate);
   const types=['Férias','Licença','Folga'];if(!employeeId||!start||!end||!types.includes(clean(b.leaveType)))return json(res,400,{error:'Funcionário, período e tipo válido são obrigatórios'});if(end<start)return json(res,400,{error:'A data final não pode ser anterior à inicial'});
   const x={id:id('FER'),employeeId,leaveType:clean(b.leaveType),startDate:start,endDate:end,status:clean(b.status)||'Pendente',reason:clean(b.reason),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   if(pool)await pool.query('INSERT INTO leaves(id,employee_id,leave_type,start_date,end_date,status,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.id,x.employeeId,x.leaveType,x.startDate,x.endDate,x.status,x.reason,x.createdAt,x.updatedAt]);else{db.leaves.unshift(x);save()}
   return json(res,201,x);
 }
 if(req.method==='PUT'&&p.startsWith('/api/hr/leaves/')&&p.split('/').length===5){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const k=decodeURIComponent(p.split('/').pop()),b=await body(req),status=clean(b.status);if(!['Pendente','Aprovada','Rejeitada','Concluída'].includes(status))return json(res,400,{error:'Estado inválido'});
   if(pool){const r=await pool.query('UPDATE leaves SET status=$1,updated_at=$2 WHERE id=$3 RETURNING id,employee_id "employeeId",leave_type "leaveType",start_date "startDate",end_date "endDate",status,reason,created_at "createdAt",updated_at "updatedAt"',[status,new Date().toISOString(),k]);if(!r.rowCount)return json(res,404,{error:'Pedido não encontrado'});return json(res,200,r.rows[0])}
   const x=db.leaves.find(q=>q.id===k);if(!x)return json(res,404,{error:'Pedido não encontrado'});x.status=status;x.updatedAt=new Date().toISOString();save();return json(res,200,x);
 }
 if(req.method==='GET'&&p==='/api/hr/summary'){
   if(!auth(req))return json(res,401,{error:'Não autorizado'});const employees=pool?(await pool.query('SELECT status,area_code "areaCode",salary FROM employees')).rows:db.employees;const att=pool?(await pool.query('SELECT status FROM attendance')).rows:db.attendance;const leaves=pool?(await pool.query('SELECT status FROM leaves')).rows:db.leaves;
   const active=employees.filter(x=>x.status==='Ativo');const payroll=active.reduce((n,x)=>n+Number(x.salary||0),0);const byStatus={};for(const x of employees)byStatus[x.status]=(byStatus[x.status]||0)+1;const byAttendance={};for(const x of att)byAttendance[x.status]=(byAttendance[x.status]||0)+1;
   return json(res,200,{totalEmployees:employees.length,activeEmployees:active.length,inactiveEmployees:employees.filter(x=>x.status!=='Ativo').length,monthlyPayroll:payroll,pendingLeaves:leaves.filter(x=>x.status==='Pendente').length,approvedLeaves:leaves.filter(x=>x.status==='Aprovada').length,attendance:byAttendance,employeesByStatus:byStatus});
 }
 if(req.method==='GET'&&p==='/api/reports'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const [ps,os,cs,qs]=await Promise.all([productsAll(),ordersAll(),customersAll(),quotesAll()]);let suppliers=[],purchases=[],sales=[],expenses=[],cash=[];if(pool){const [a,b,c,d,e]=await Promise.all([pool.query('SELECT * FROM suppliers'),pool.query('SELECT total,status FROM purchases'),pool.query('SELECT total,status FROM sales'),pool.query('SELECT amount FROM expenses'),pool.query('SELECT type,amount FROM cash_movements')]);suppliers=a.rows;purchases=b.rows;sales=c.rows;expenses=d.rows;cash=e.rows}else{({suppliers,purchases,sales,expenses,cashMovements:cash}=db)}const sum=a=>a.reduce((n,x)=>n+Number(x.total||x.amount||0),0);return json(res,200,{customers:cs.length,suppliers:suppliers.length,products:ps.length,orders:os.length,quotes:qs.length,purchases:purchases.length,sales:sales.length,expenses:expenses.length,revenue:sum(sales),purchasesValue:sum(purchases),expensesValue:sum(expenses),cashIn:sum(cash.filter(x=>x.type==='Entrada')),cashOut:sum(cash.filter(x=>x.type==='Saída')),stockValue:ps.reduce((n,x)=>n+(Number(x.stock)||0)*(Number(String(x.price||'').replace(/[^0-9.,]/g,'').replace(',','.'))||0),0)});}
 if(req.method==='GET'&&p==='/api/dashboard'){if(!auth(req))return json(res,401,{error:'Não autorizado'});const ps=await productsAll(),os=await ordersAll(),cs=await customersAll(),qs=await quotesAll();const ae=await areaEntriesAll(),ax=await areaExpensesAll();
 const areaRevenue=ae.reduce((n,x)=>n+Number(x.amount||0),0),areaExpenses=ax.reduce((n,x)=>n+Number(x.amount||0),0);
 const crmTasks=await crmTasksAll(),crmDeals=await crmDealsAll();const crmPipeline=crmDeals.reduce((n,x)=>n+Number(x.value||0),0);return json(res,200,{products:ps.length,activeProducts:ps.filter(x=>x.status!=='Inativo').length,orders:os.length,pendingOrders:os.filter(x=>!['Concluído','Cancelado'].includes(x.status)).length,customers:cs.length,quotes:qs.length,pendingQuotes:qs.filter(x=>!['Aprovado','Cancelado'].includes(x.status)).length,areas:AREA_DEFS.length,areaRevenue,areaExpenses,areaResult:areaRevenue-areaExpenses,crmDeals:crmDeals.length,crmPipeline,crmPendingTasks:crmTasks.filter(x=>x.status!=='Concluída').length});}
 const handledFuture=await future.handle(req,res,{db,save,json,body,session});
 if(handledFuture || res.writableEnded)return;
 const handled2630=await future2630.handle(req,res,{db,save,json,body,session});
 if(handled2630 || res.writableEnded)return;
 const handled3134=await future3134.handle(req,res,{db,save,json,body,session});
 if(handled3134 || res.writableEnded)return;
 const handledFinance=await financeRoutes({db,save,requireAdmin:(req)=>session(req),json,parseBody:body})(req,res);
 if(handledFinance || res.writableEnded)return;
 return json(res,404,{error:'Rota não encontrada'});
}
function serve(req,res){let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(p==='/')p='/index.html';const f=path.normalize(path.join(PUBLIC,p));if(!f.startsWith(PUBLIC))return json(res,403,{error:'Forbidden'});fs.readFile(f,(e,d)=>{if(e)return json(res,404,{error:'Ficheiro não encontrado'});const ext=path.extname(f);const t={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':t,'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin'});res.end(d)})}

(async()=>{try{await pgInit();http.createServer(async(req,res)=>{try{if(req.url.startsWith('/api/'))await api(req,res);else serve(req,res)}catch(e){console.error(e);json(res,500,{error:'Erro interno'})}}).listen(PORT,()=>console.log(`RBS V34: http://localhost:${PORT}`));}catch(e){console.error('Falha ao inicializar PostgreSQL:',e);process.exit(1)}})();

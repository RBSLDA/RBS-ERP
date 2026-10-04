
// RBS V16 - Financeiro
const crypto = require("crypto");

function money(v){ return Math.round(Number(v||0)*100)/100; }
function id(prefix){ return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; }

function ensureFinance(db){
  db.receivables ||= [];
  db.payables ||= [];
  db.payments ||= [];
  db.receipts ||= [];
  db.cash ||= [];
  return db;
}

function recalcFinance(db){
  ensureFinance(db);
  for(const r of db.receivables){
    r.paid = money(db.payments.filter(p=>p.type==="receivable" && p.referenceId===r.id && p.status!=="cancelled").reduce((s,p)=>s+Number(p.amount||0),0));
    r.balance = money(Math.max(0, Number(r.total||0)-r.paid));
    r.status = r.balance<=0 ? "paid" : r.paid>0 ? "partial" : (r.dueDate && r.dueDate < new Date().toISOString().slice(0,10) ? "overdue" : "pending");
  }
  for(const r of db.payables){
    r.paid = money(db.payments.filter(p=>p.type==="payable" && p.referenceId===r.id && p.status!=="cancelled").reduce((s,p)=>s+Number(p.amount||0),0));
    r.balance = money(Math.max(0, Number(r.total||0)-r.paid));
    r.status = r.balance<=0 ? "paid" : r.paid>0 ? "partial" : (r.dueDate && r.dueDate < new Date().toISOString().slice(0,10) ? "overdue" : "pending");
  }
  return db;
}

function financeRoutes({db, save, requireAdmin, json, parseBody}){
  return async function(req,res){
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname;
    if(!p.startsWith("/api/finance")) return false;
    ensureFinance(db); recalcFinance(db);

    if(req.method==="GET" && p==="/api/finance/summary"){
      const sum=(a)=>money(a.reduce((s,x)=>s+Number(x||0),0));
      const incoming=sum(db.cash.filter(x=>x.direction==="in").map(x=>x.amount));
      const outgoing=sum(db.cash.filter(x=>x.direction==="out").map(x=>x.amount));
      return json(res,200,{ok:true,summary:{
        receivable:sum(db.receivables.map(x=>x.balance)),
        payable:sum(db.payables.map(x=>x.balance)),
        received:sum(db.payments.filter(x=>x.type==="receivable" && x.status!=="cancelled").map(x=>x.amount)),
        paid:sum(db.payments.filter(x=>x.type==="payable" && x.status!=="cancelled").map(x=>x.amount)),
        cashIn:incoming,cashOut:outgoing,cashBalance:money(incoming-outgoing),
        overdueReceivable:sum(db.receivables.filter(x=>x.status==="overdue").map(x=>x.balance)),
        overduePayable:sum(db.payables.filter(x=>x.status==="overdue").map(x=>x.balance))
      }});
    }

    if(req.method==="GET" && p==="/api/finance/receivables") return json(res,200,{ok:true,data:db.receivables});
    if(req.method==="GET" && p==="/api/finance/payables") return json(res,200,{ok:true,data:db.payables});
    if(req.method==="GET" && p==="/api/finance/payments") return json(res,200,{ok:true,data:db.payments});
    if(req.method==="GET" && p==="/api/finance/receipts") return json(res,200,{ok:true,data:db.receipts});
    if(req.method==="GET" && p==="/api/finance/cash") return json(res,200,{ok:true,data:db.cash});

    if(!requireAdmin(req,res)) return true;

    if(req.method==="POST" && p==="/api/finance/receivables"){
      const b=await parseBody(req);
      const total=money(b.total);
      if(total<=0) return json(res,400,{ok:false,error:"total inválido"});
      const r={id:id("AR"), customerId:b.customerId||null, customerName:b.customerName||"", documentId:b.documentId||null, documentNumber:b.documentNumber||"", total, paid:0,balance:total,dueDate:b.dueDate||null,status:"pending",notes:b.notes||"",createdAt:new Date().toISOString()};
      db.receivables.push(r); save(); return json(res,201,{ok:true,data:r});
    }

    if(req.method==="POST" && p==="/api/finance/payables"){
      const b=await parseBody(req); const total=money(b.total);
      if(total<=0) return json(res,400,{ok:false,error:"total inválido"});
      const r={id:id("AP"), supplierId:b.supplierId||null,supplierName:b.supplierName||"",documentId:b.documentId||null,documentNumber:b.documentNumber||"",total,paid:0,balance:total,dueDate:b.dueDate||null,status:"pending",notes:b.notes||"",createdAt:new Date().toISOString()};
      db.payables.push(r); save(); return json(res,201,{ok:true,data:r});
    }

    if(req.method==="POST" && p==="/api/finance/payment"){
      const b=await parseBody(req); const amount=money(b.amount);
      if(amount<=0 || !["receivable","payable"].includes(b.type)) return json(res,400,{ok:false,error:"pagamento inválido"});
      const list=b.type==="receivable"?db.receivables:db.payables;
      const ref=list.find(x=>x.id===b.referenceId);
      if(!ref) return json(res,404,{ok:false,error:"conta não encontrada"});
      recalcFinance(db);
      if(amount>ref.balance) return json(res,400,{ok:false,error:"valor superior ao saldo em aberto"});
      const pay={id:id("PAY"),type:b.type,referenceId:ref.id,amount,method:b.method||"cash",date:b.date||new Date().toISOString().slice(0,10),notes:b.notes||"",status:"confirmed",createdAt:new Date().toISOString()};
      db.payments.push(pay);
      db.cash.push({id:id("CASH"),direction:b.type==="receivable"?"in":"out",amount,method:pay.method,date:pay.date,referenceId:pay.id,description:b.type==="receivable"?`Recebimento ${ref.documentNumber||ref.id}`:`Pagamento ${ref.documentNumber||ref.id}`,createdAt:new Date().toISOString()});
      if(b.type==="receivable"){
        recalcFinance(db);
        const receipt={id:id("REC"),number:`REC/${new Date().getFullYear()}/${String(db.receipts.length+1).padStart(5,"0")}`,paymentId:pay.id,customerId:ref.customerId,customerName:ref.customerName,documentId:ref.documentId,amount,date:pay.date,method:pay.method,balance:ref.balance,createdAt:new Date().toISOString()};
        db.receipts.push(receipt);
      }
      recalcFinance(db); save(); return json(res,201,{ok:true,data:pay,account:ref,receipt:b.type==="receivable"?db.receipts.at(-1):null});
    }

    return json(res,404,{ok:false,error:"rota financeira não encontrada"});
  };
}

module.exports={ensureFinance,recalcFinance,financeRoutes};

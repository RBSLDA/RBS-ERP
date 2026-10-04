# RBS V16 — Integração Financeira

## Endpoints
GET  /api/finance/summary
GET  /api/finance/receivables
GET  /api/finance/payables
GET  /api/finance/payments
GET  /api/finance/receipts
GET  /api/finance/cash

POST /api/finance/receivables
POST /api/finance/payables
POST /api/finance/payment

## Integração no server.js
No início:
const { ensureFinance, recalcFinance, financeRoutes } = require("./finance-v16");

Depois de carregar a base:
ensureFinance(db);
recalcFinance(db);

No fluxo principal da API, antes do 404:
const handledFinance = await financeRoutes({db, save, requireAdmin, json, parseBody})(req,res);
if (handledFinance) return;

## Página
financeiro.html é um painel financeiro protegido pela mesma sessão administrativa.

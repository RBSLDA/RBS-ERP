# RBS V17 — Testes realizados

Data de validação: 2026-10-03

## Sintaxe
- `node --check server.js` — OK
- `node --check areas-v17.js` — OK
- `node --check` nos restantes JavaScript públicos e `finance-v16.js` — OK

## Servidor
- Inicialização local — OK
- `GET /api/health` — OK
- `GET /api/products` — OK (18 produtos no conjunto de teste)
- `GET /api/documents` — OK
- `GET /api/customers` — OK
- Login administrativo por sessão — OK

## V17
- `GET /api/areas` — OK (8 áreas)
- `GET /api/areas/summary` — OK
- `GET /api/areas/entries` — OK
- `GET /api/areas/expenses` — OK
- `GET /api/areas/cost-centers` — OK
- `POST /api/areas/cost-centers` — OK
- `POST /api/areas/entries` — OK
- `POST /api/areas/expenses` — OK
- Resultado por área — OK: 100.000 Kz - 25.000 Kz = 75.000 Kz no cenário de teste
- Stock por área — OK: 10 unidades refletidas na área Digital no cenário de teste
- `PUT /api/areas/DIGITAL` — OK
- Dashboard geral com indicadores V17 — OK

## V16
- Rotas financeiras V16 — OK (`/api/finance/summary` testada)
- O módulo `finance-v16.js` foi integrado corretamente por `require`, substituindo a chamada quebrada que existia no início do `server.js`.

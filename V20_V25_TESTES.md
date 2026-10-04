# Testes V20–V25
- `node --check server.js` — OK
- `node --check future-v20-v25.js` — OK
- Login/sessão — OK
- V20 resumo, contacto de fornecedor e plano de compra — OK
- V21 resumo, lote e contagem — OK
- V22 venda POS, validação de stock, baixa de stock e entrada de caixa — OK
- V23 criação e cálculo de orçamento — OK
- V24 projecto, tarefa e custo — OK
- V25 ordem de serviço, alteração de estado e tarefa técnica — OK
- Resumos V20, V21, V22, V23, V24 e V25 — OK
- `GET /api/health` com versão 25.0.0 — OK
Nota: os testes funcionais foram executados no modo de persistência JSON. Não foi configurada uma instância PostgreSQL real durante esta validação.

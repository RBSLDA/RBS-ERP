# Integração V19

V19 parte diretamente da V18 e preserva Financeiro, Áreas/Centros de Custo, RH, Stock, Compras, Vendas, Documentos e Orçamentos.

Novas rotas:
- GET /api/crm/dashboard
- GET/POST /api/crm/interactions
- GET/POST /api/crm/tasks
- PUT /api/crm/tasks/:id
- GET/POST /api/crm/deals
- PUT /api/crm/deals/:id
- PUT /api/customers/:id

O dashboard geral passa a expor crmDeals, crmPipeline e crmPendingTasks.

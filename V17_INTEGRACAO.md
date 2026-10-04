# RBS V17 — Integração

A V17 parte diretamente da V16 e mantém:
- clientes, fornecedores, produtos e stock;
- compras e vendas;
- caixa;
- documentos ORC/PRO/FAT/REC;
- financeiro V16;
- autenticação por sessão;
- persistência JSON/PostgreSQL.

A integração financeira da V16 foi ligada de forma explícita pelo módulo `finance-v16.js`, sem injeção frágil de código.

A gestão por áreas utiliza os códigos:
- MOTO
- CONSTRUCAO
- FASHION
- GRAFICA
- DIGITAL
- SERVICOS
- DELIVERY
- START

O stock por área é calculado pela área atribuída aos produtos existentes.

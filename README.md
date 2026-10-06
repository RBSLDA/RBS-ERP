# RBS Plataforma Comercial V12

Evolução da plataforma RBS para um núcleo comercial/ERP inicial.

## Inclui
- Site institucional e catálogo público
- API Node.js
- PostgreSQL opcional para produção
- Persistência JSON para desenvolvimento
- Login administrativo com sessão HTTP-only
- Produtos e serviços
- Pedidos
- Dashboard comercial
- CRM inicial de clientes
- Orçamentos (estrutura inicial)
- Movimentos de stock
- Upload de imagens
- Docker e documentação de deploy

## Arranque local
```bash
npm install
RBS_ADMIN_USER=admin RBS_ADMIN_PASSWORD=147257-Ss node server.js
```
Abra `/` para o site e `/admin.html` para a gestão.

## Nota
A V12 prepara o núcleo comercial. Não simula faturação fiscal, pagamentos bancários ou gateways de pagamento.


## V14
Ver `V14.md` para o ciclo de compras, vendas, stock e caixa.


## V15 — Documentos

Use `/documentos.html` para consultar documentos quando autenticado. A API oferece `/api/documents` para ORC, PRO, FAT e REC. A impressão do navegador permite guardar em PDF.


## V20–V25
Fornecedores e compras avançadas, stock profissional, POS, orçamentos profissionais, projetos/obras e serviços técnicos. Ver V20.md a V25.md e V20_V25_TESTES.md.

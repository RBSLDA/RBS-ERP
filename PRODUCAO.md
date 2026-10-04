# RBS — Checklist de Produção V10

1. Contratar servidor/VPS com Docker.
2. Apontar o domínio para o IP do servidor.
3. Criar `.env` a partir de `.env.production.example` e definir uma palavra-passe forte/hash.
4. Subir a aplicação com Docker Compose.
5. Configurar TLS com Let's Encrypt/Certbot ou um proxy TLS gerido.
6. Executar `scripts/backup.sh` diariamente via cron/systemd timer.
7. Testar `/api/health`, login administrativo, catálogo e pedido.
8. Não publicar `.env`, `data/` ou `backups/` num repositório público.
9. Fazer cópias dos backups fora do servidor.

## Importante
O domínio e o servidor reais ainda precisam ser fornecidos/configurados. Esta V10 deixa os ficheiros e procedimentos prontos, mas não pode publicar a plataforma sem acesso ao provedor/servidor e ao domínio.

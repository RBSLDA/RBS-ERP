# RBS V9 — Publicação

## Docker
1. Copie `.env.example` para `.env`.
2. Defina uma palavra-passe forte ou `RBS_ADMIN_PASSWORD_HASH`.
3. Execute `docker compose up -d --build`.
4. Teste `http://SERVIDOR:3000/api/health`.
5. Coloque HTTPS/reverse proxy na frente do serviço antes de abrir ao público.

## Palavra-passe com scrypt
Pode gerar um hash com Node:

```bash
node -e "const c=require('crypto');const p=process.argv[1];const s=c.randomBytes(16);const k=c.scryptSync(p,s,32);console.log(s.toString('hex')+':'+k.toString('hex'))" 'SUA_SENHA_FORTE'
```

Coloque o resultado em `RBS_ADMIN_PASSWORD_HASH` e deixe `RBS_ADMIN_PASSWORD` apenas como fallback local.

## Dados
Os dados ficam no volume Docker `rbs_data`. Faça backups regulares de `data/rbs.json`.

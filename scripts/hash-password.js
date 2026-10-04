const crypto=require('crypto');
const p=process.argv[2];
if(!p){console.error('Uso: node scripts/hash-password.js "SENHA"');process.exit(1)}
const salt=crypto.randomBytes(16),key=crypto.scryptSync(p,salt,32);
console.log(`${salt.toString('hex')}:${key.toString('hex')}`);

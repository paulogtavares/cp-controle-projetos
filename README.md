# C.P · Controle Projetos

Painel de gestão integrado ao Jira. Funciona localmente e publicado na nuvem.

---

## Publicar no Railway (online em 5 min)

### 1. Criar conta
Acesse https://railway.app e faça login com GitHub.

### 2. Criar repositório no GitHub
```bash
git init
git add .
git commit -m "primeiro commit"
git remote add origin https://github.com/SEU_USUARIO/cp-controle-projetos.git
git push -u origin main
```

### 3. Novo projeto no Railway
- Clique em **New Project → Deploy from GitHub repo**
- Selecione o repositório criado
- Railway detecta o `package.json` e faz deploy automático

### 4. Adicionar variáveis de ambiente
No painel do Railway vá em **Variables** e adicione:

| Variável      | Valor                              |
|---------------|------------------------------------|
| `JIRA_EMAIL`  | paulo.tavares@infracommerce.com.br |
| `JIRA_TOKEN`  | seu API token do Jira              |
| `JIRA_DOMAIN` | infracommerce.atlassian.net        |
| `JIRA_PROJECT`| ODYJS                              |

### 5. Acessar
Railway gera uma URL como `https://cp-controle-projetos.up.railway.app`.
Clique em **Generate Domain** para obter o endereço público.

---

## Usar localmente

Requisito: Node.js instalado (https://nodejs.org)

**Windows:** duplo clique em `iniciar.bat`
**Mac/Linux:** `node server.js`

Acesse: http://localhost:3131

---

## Variáveis de ambiente

| Variável       | Descrição                          | Padrão                          |
|----------------|------------------------------------|---------------------------------|
| `JIRA_EMAIL`   | E-mail do Atlassian                | —                               |
| `JIRA_TOKEN`   | API Token do Jira                  | —                               |
| `JIRA_DOMAIN`  | Domínio do Jira                    | infracommerce.atlassian.net     |
| `JIRA_PROJECT` | Chave do projeto                   | ODYJS                           |
| `PORT`         | Porta (Railway define sozinho)     | 3131                            |

---

## Gerar API Token
https://id.atlassian.com/manage-profile/security/api-tokens

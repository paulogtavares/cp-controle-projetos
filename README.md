# C.P · Controle Projetos

Plataforma de gestão integrada ao Jira — Infracommerce.

---

## Versionamento

A versão é controlada no `package.json`. Para registrar uma alteração:

### 1. Antes de qualquer mudança — atualize o package.json

```json
{
  "version": "2.2.0",
  "buildDate": "2026-03-20"
}
```

**Regra de versão semântica:**

| Tipo de mudança | O que incrementar | Exemplo |
|---|---|---|
| Correção de bug pequeno | Patch (último número) | 2.1.0 → 2.1.1 |
| Nova funcionalidade | Minor (número do meio) | 2.1.0 → 2.2.0 |
| Reescrita / mudança grande | Major (primeiro número) | 2.1.0 → 3.0.0 |

### 2. Commitar com mensagem descritiva

```bash
git add .
git commit -m "v2.2.0 - descricao clara do que mudou"
git push
```

### 3. Onde a versão aparece

- **Sidebar da plataforma** — abaixo do logo (ex: `v2.1.0 · 2026-03-19`)
- **Rodapé da sidebar** — visível em telas menores
- **Terminal** — exibida no banner ao iniciar o servidor
- **GET /api/status** — campos `version` e `buildDate`

---

## Fazer Rollback

### Opção A — Rollback pelo GitHub (recomendado)

```bash
# Ver histórico de commits
git log --oneline

# Voltar para um commit específico
git revert <hash-do-commit>
git push
```

O Railway faz redeploy automático.

### Opção B — Rollback com arquivo ZIP

Se tiver o ZIP de uma versão anterior:
1. Extraia o ZIP
2. Copie os arquivos para a pasta do projeto
3. Atualize o `buildDate` no `package.json` para a data de hoje
4. Faça o commit e push normalmente

---

## Rodar Localmente

**Windows:** duplo clique em `iniciar.bat`
**Mac/Linux:** `node server.js`
Acesse: http://localhost:3131

---

## Variáveis de Ambiente (Railway)

| Variável | Valor |
|---|---|
| `JIRA_EMAIL` | paulo.tavares@infracommerce.com.br |
| `JIRA_TOKEN` | API Token do Jira |
| `JIRA_DOMAIN` | infracommerce.atlassian.net |
| `JIRA_PROJECT` | ODYJS |

/**
 * C.P · Controle Projetos
 * Funciona localmente (config.json) e em nuvem (variáveis de ambiente).
 *
 * Variáveis de ambiente para Railway/Render:
 *   JIRA_EMAIL   — seu e-mail do Atlassian
 *   JIRA_TOKEN   — API token do Jira
 *   JIRA_DOMAIN  — ex: infracommerce.atlassian.net
 *   JIRA_PROJECT — ex: ODYJS
 *   PORT         — definida automaticamente pelo Railway
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Versão lida do package.json (fonte da verdade) ────────────────────────────
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const APP_VERSION   = PKG.version    || '0.0.0';
const APP_BUILD     = PKG.buildDate  || '—';

// ── Porta: Railway define PORT automaticamente ────────────────────────────────
const PORT        = process.env.PORT || 3131;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const IS_CLOUD    = !!(process.env.JIRA_EMAIL); // detecta se está em nuvem

function log(...a) { console.log(new Date().toLocaleTimeString('pt-BR'), ...a); }

// ── Config: lê variáveis de ambiente OU config.json local ────────────────────
function loadConfig() {
  let cfg = {};
  // Variáveis de ambiente têm prioridade (Railway/Render/etc)
  if (process.env.JIRA_EMAIL) {
    cfg = {
      email:   process.env.JIRA_EMAIL.trim(),
      token:   process.env.JIRA_TOKEN.trim(),
      domain:  (process.env.JIRA_DOMAIN || 'infracommerce.atlassian.net').trim().replace(/^https?:\/\//, ''),
      project: (process.env.JIRA_PROJECT || 'ODYJS').trim().toUpperCase(),
    };
  } else {
    // Fallback: arquivo local (uso em desenvolvimento)
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { cfg = {}; }
  }
  // Sempre lê inactivePersons do state.json (persiste entre deploys no Railway)
  const stateFile = path.join(__dirname, 'state.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    cfg.inactivePersons = state.inactivePersons || [];
  } catch {
    cfg.inactivePersons = cfg.inactivePersons || [];
  }
  return cfg;
}

function saveConfig(c) {
  // Em nuvem não salva arquivo — usa variáveis de ambiente
  if (IS_CLOUD) return;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function json(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({}); } });
    req.on('error', fail);
  });
}

// ── Jira request ──────────────────────────────────────────────────────────────
function jiraGet(cfg, jiraPath) {
  return new Promise((ok, fail) => {
    const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
    log('→ GET', jiraPath.split('?')[0]);
    const req = https.request({
      hostname: cfg.domain, path: jiraPath, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout: 25000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        log(`← HTTP ${res.statusCode} (${raw.length}b)`);
        let data = null;
        try { data = JSON.parse(raw); } catch { log('  [!] não-JSON:', raw.slice(0, 150)); }
        ok({ status: res.statusCode, data, raw: raw.slice(0, 500) });
      });
    });
    req.on('error', e => { log('  erro rede:', e.message); fail(e); });
    req.on('timeout', () => { req.destroy(); fail(new Error('Timeout (25s)')); });
    req.end();
  });
}

// ── Validação de resposta ─────────────────────────────────────────────────────
function checkErrors(status, data, raw) {
  if (status === 401) throw new Error('Credenciais inválidas (401). Verifique e-mail e token.');
  if (status === 403) throw new Error('Sem permissão (403). Verifique acesso ao projeto.');
  if (status === 404) throw new Error('Projeto não encontrado (404). Verifique a chave do projeto.');
  if (!data) throw new Error(`Jira retornou resposta não-JSON (HTTP ${status}): ${(raw || '').slice(0, 200)}`);
  if (Array.isArray(data.errorMessages) && data.errorMessages.length) throw new Error(data.errorMessages.join(' | '));
  if (data.errors && Object.keys(data.errors).length) throw new Error(Object.values(data.errors).join(' | '));
  if (status >= 400 && data.message) throw new Error(data.message);
}

// ── Mapeamento de status ──────────────────────────────────────────────────────
const STATUS_MAP = {
  // ── Backlog ──────────────────────────────────────────────────────────────
  'Backlog':                        'Backlog',
  'Análise Comercial':              'Backlog',
  'To Do':                          'Backlog',
  'Open':                           'Backlog',

  // ── Em Andamento ─────────────────────────────────────────────────────────
  'Em Andamento':                   'Em Andamento',
  'Escopo Product Owner':           'Em Andamento',
  'High Level':                     'Em Andamento',
  'In Progress':                    'Em Andamento',

  // ── Proposta Enviada ──────────────────────────────────────────────────────
  'Proposta Enviada':               'Proposta Enviada',

  // ── Aguardando Cliente ────────────────────────────────────────────────────
  'Aguardando Cliente':             'Aguardando Cliente',
  'Aguardando cliente':             'Aguardando Cliente',
  'Aprovação Escopo por Cliente':   'Aguardando Cliente',
  'Awaiting Schedule':              'Aguardando Cliente',

  // ── Aguardando Execução ───────────────────────────────────────────────────
  'Aguardando Execução':            'Aguardando Execução',
  'Aguardando homologação':         'Aguardando Execução',
  'In Review':                      'Aguardando Execução',

  // ── Em Execução ───────────────────────────────────────────────────────────
  'Em Execução':                    'Em Execução',
  'In Execution':                   'Em Execução',

  // ── Concluído (inclui Concluído + Executed) ───────────────────────────────
  'Concluído':                      'Concluído',
  'Executed':                       'Concluído',
  'Resolvido':                      'Concluído',
  'Done':                           'Concluído',
  'Closed':                         'Concluído',
  'Resolved':                       'Concluído',

  // ── Recusado / Cancelado (inclui Recusado + Cancelado) ───────────────────
  'Recusado / Cancelado':           'Recusado / Cancelado',
  'Cancelado':                      'Recusado / Cancelado',
  'Cancelled':                      'Recusado / Cancelado',
  "Won't Do":                      'Recusado / Cancelado',
  'Recusado':                       'Recusado / Cancelado',
};
function mapStatus(raw) {
  if (!raw) return 'Backlog';
  if (STATUS_MAP[raw]) return STATUS_MAP[raw];
  for (const [k, v] of Object.entries(STATUS_MAP)) if (k.toLowerCase() === raw.toLowerCase()) return v;
  return 'Backlog';
}

function detectClient(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('SWAROVSKI')) return 'Swarovski';
  if (u.includes('HERMAN MILLER') || u.includes('HERMANMILLER') || /CSB2C-\d/.test(u)) return 'HermanMiller';
  if (u.includes('SECULUS')) return 'Seculus';
  if (u.includes('ANDINA') || u.includes('COCA COLA')) return 'Andina Coca Cola';
  if (u.includes('DIOR')) return 'Dior';
  if (u.includes('WELLA')) return 'Wella';
  if (u.includes('IWC')) return 'IWC';
  if (u.includes('CARTIER')) return 'Cartier';
  if (u.includes('MONTBLANC')) return 'Montblanc';
  if (u.includes('ARMANI')) return 'Armani';
  if (u.includes('WALITA')) return 'Walita';
  if (u.includes('ELC') || u.includes('TOM FORD')) return 'ELC / Tom Ford';
  if (u.includes('BLACK') && u.includes('DECKER')) return 'Black & Decker';
  if (u.includes('PALMEIRAS')) return 'Palmeiras';
  if (u.includes('DUX')) return 'Dux';
  if (u.includes('PHILIPS')) return 'Philips';
  return 'Outros';
}

function parseIssue(i, domain) {
  const f = i.fields || {};
  const sp = f.customfield_10016 ?? f.customfield_10028 ?? null;
  return {
    key: i.key, summary: (f.summary || '').trim(),
    rawStatus: f.status?.name || '', status: mapStatus(f.status?.name),
    assignee: f.assignee?.displayName || 'Sem responsável',
    type: f.issuetype?.name || 'História', priority: f.priority?.name || 'Medium',
    sp: sp != null ? Number(sp) : null, client: detectClient(f.summary),
    created: (f.created || '').slice(0, 10), updated: (f.updated || '').slice(0, 10),
    url: `https://${domain}/browse/${i.key}`,
  };
}

// ── Busca paginada com fallback ───────────────────────────────────────────────
async function fetchAllIssues(cfg, jqlExtra = '') {
  const fields = 'summary,status,assignee,issuetype,priority,customfield_10016,customfield_10028,created,updated';
  const base   = `project = "${cfg.project}"` + (jqlExtra ? ` AND ${jqlExtra}` : '');
  const jql    = encodeURIComponent(base + ' ORDER BY created DESC');
  const all    = [];

  log('Buscando issues via /search/jql...');
  try {
    let nextPageToken = null, page = 0;
    while (true) {
      page++;
      let p = `/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${fields}`;
      if (nextPageToken) p += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      const { status, data, raw } = await jiraGet(cfg, p);
      checkErrors(status, data, raw);
      if (!Array.isArray(data.issues)) { log('  sem campo issues, tentando fallback...'); break; }
      all.push(...data.issues);
      log(`  pág ${page}: +${data.issues.length} = ${all.length}`);
      nextPageToken = data.nextPageToken || null;
      if (data.isLast === true || !nextPageToken || data.issues.length === 0) {
        log(`  concluído: ${all.length} issues`);
        return all.map(i => parseIssue(i, cfg.domain));
      }
    }
  } catch (e) {
    if (e.message.match(/401|403|404/)) throw e;
    log('  /search/jql erro:', e.message);
    all.length = 0;
  }

  // Fallback: /search com startAt
  log('Fallback: /search com startAt...');
  all.length = 0;
  let startAt = 0, total = Infinity;
  while (all.length < total) {
    const p = `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=50&fields=${fields}`;
    const { status, data, raw } = await jiraGet(cfg, p);
    checkErrors(status, data, raw);
    if (!Array.isArray(data.issues)) {
      throw new Error(
        `Jira não retornou campo "issues".\n` +
        `HTTP ${status} — Chaves: ${data ? Object.keys(data).join(', ') : 'nenhuma'}\n` +
        `Resposta: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    total = typeof data.total === 'number' ? data.total : data.issues.length;
    all.push(...data.issues);
    log(`  startAt=${startAt}: +${data.issues.length} = ${all.length}/${total}`);
    if (data.issues.length === 0 || all.length >= total) break;
    startAt += 50;
  }
  log(`Total: ${all.length} issues`);
  return all.map(i => parseIssue(i, cfg.domain));
}

async function testConnection(cfg) {
  const jql = encodeURIComponent(`project = "${cfg.project}" ORDER BY created DESC`);
  let r = await jiraGet(cfg, `/rest/api/3/search/jql?jql=${jql}&maxResults=1&fields=summary`);
  if (r.status >= 400 && r.status !== 401 && r.status !== 403) {
    r = await jiraGet(cfg, `/rest/api/3/search?jql=${jql}&maxResults=1&fields=summary`);
  }
  checkErrors(r.status, r.data, r.raw);
  if (!Array.isArray(r.data?.issues)) throw new Error('Conectado mas sem campo "issues". Chaves: ' + Object.keys(r.data || {}).join(', '));
  return r.data.total ?? r.data.issues.length ?? 0;
}

// ── Rotas ─────────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const { pathname } = url.parse(req.url);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // Frontend
  if (pathname === '/' || pathname === '/index.html') {
    const p = path.join(__dirname, 'index.html');
    if (!fs.existsSync(p)) { json(res, 404, { error: 'index.html não encontrado' }); return; }
    cors(res); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(p, 'utf8'));
    return;
  }

  if (pathname === '/api/status') {
    const cfg = loadConfig();
    json(res, 200, {
      running:    true,
      configured: !!(cfg.email && cfg.token && cfg.domain && cfg.project),
      cloud:      IS_CLOUD,
      version:    APP_VERSION,
      buildDate:  APP_BUILD,
      port:       PORT,
    });
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig();
    json(res, 200, {
      configured: !!(cfg.email && cfg.token && cfg.domain && cfg.project),
      cloud: IS_CLOUD, // frontend usa isso para saber se deve mostrar formulário
      email: cfg.email || '',
      domain: cfg.domain || 'infracommerce.atlassian.net',
      project: cfg.project || 'ODYJS',
    });
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    // Em nuvem (Railway), config vem de variáveis de ambiente — não aceita POST
    if (IS_CLOUD) {
      json(res, 400, { error: 'Em modo nuvem as credenciais são configuradas via variáveis de ambiente no Railway.' });
      return;
    }
    const b = await readBody(req);
    const { email, token, domain, project } = b;
    if (!email || !token || !domain || !project) { json(res, 400, { error: 'Preencha todos os campos.' }); return; }
    const cfg = {
      email: email.trim(), token: token.trim(),
      domain: domain.trim().replace(/^https?:\/\//, ''),
      project: project.trim().toUpperCase(),
    };
    log(`Testando: ${cfg.email} → ${cfg.domain}/${cfg.project}`);
    try {
      const total = await testConnection(cfg);
      saveConfig(cfg);
      log(`OK — ${total} issues.`);
      json(res, 200, { ok: true, total, message: `Conectado! ${total} issues encontrados.` });
    } catch (e) {
      log('Erro:', e.message);
      json(res, 400, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/issues' && req.method === 'GET') {
    const cfg = loadConfig();
    if (!cfg.email || !cfg.token) { json(res, 401, { error: 'Não configurado.' }); return; }
    log(`Issues: ${cfg.project}@${cfg.domain}`);
    try {
      const issues = await fetchAllIssues(cfg);
      json(res, 200, { ok: true, total: issues.length, issues, syncedAt: new Date().toISOString() });
    } catch (e) {
      log('Erro issues:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/inactive — retorna lista de pessoas inativas
  if (pathname === '/api/inactive' && req.method === 'GET') {
    const cfg = loadConfig();
    json(res, 200, { inactive: cfg.inactivePersons || [] });
    return;
  }

  // POST /api/inactive — salva lista de pessoas inativas
  if (pathname === '/api/inactive' && req.method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.inactive)) {
      json(res, 400, { error: 'Campo "inactive" deve ser um array.' }); return;
    }
    const cfg = loadConfig();
    cfg.inactivePersons = b.inactive;
    // Em modo nuvem salva em arquivo de estado separado (não sobrescreve env vars)
    const stateFile = path.join(__dirname, 'state.json');
    try {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      state.inactivePersons = b.inactive;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch(e) {
      log('Aviso: não foi possível salvar state.json:', e.message);
    }
    // Também tenta salvar no config.json (modo local)
    if (!IS_CLOUD) {
      try { cfg.inactivePersons = b.inactive; saveConfig(cfg); } catch {}
    }
    json(res, 200, { ok: true, inactive: b.inactive });
    return;
  }

  json(res, 404, { error: `Rota não encontrada: ${pathname}` });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try { await handleRequest(req, res); }
  catch (e) { log('Erro interno:', e.message); json(res, 500, { error: e.message }); }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`\n  Servidor já rodando em http://localhost:${PORT}\n`); process.exit(0); }
  console.error('Erro fatal:', e.message); process.exit(1);
});

// Railway usa 0.0.0.0 (aceita conexões externas); local usa 127.0.0.1
const HOST = IS_CLOUD ? '0.0.0.0' : '127.0.0.1';

server.listen(PORT, HOST, () => {
  if (IS_CLOUD) {
    console.log(`\n  ⬡ C.P · Controle Projetos v${APP_VERSION} (${APP_BUILD}) — porta ${PORT}\n`);
  } else {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log(`  ║   ⬡  C.P · Controle Projetos  v${APP_VERSION.padEnd(6)}║`);
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log('  ╠══════════════════════════════════════╣');
    console.log('  ║   Abra o link acima no navegador     ║');
    console.log('  ║   Para parar: Ctrl+C                 ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
  }
});

process.on('SIGINT',  () => { console.log('\n  Encerrado.'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  Encerrado.'); process.exit(0); });

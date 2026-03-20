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

// ── Versão lida do package.json (fonte da verdade) ────────────────────────────
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const APP_VERSION   = PKG.version    || '0.0.0';
const APP_BUILD     = PKG.buildDate  || '—';

// ── Porta: Railway define PORT automaticamente ────────────────────────────────
const PORT        = process.env.PORT || 3131;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const IS_CLOUD    = !!(process.env.JIRA_EMAIL); // detecta se está em nuvem

function log(...a) { console.log(new Date().toLocaleTimeString('pt-BR'), ...a); }

// ── Cache em memória + arquivo ────────────────────────────────────────────────
// Estratégia: serve do cache imediatamente, atualiza em background a cada TTL
const CACHE_FILE = path.join(__dirname, 'cache.json');
const CACHE_TTL  = 5 * 60 * 1000; // 5 minutos — atualiza automaticamente
const cache = { odyjs: null, b2b1: null }; // { issues, syncedAt, updatingAt }

function loadCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw.odyjs) cache.odyjs = raw.odyjs;
    if (raw.b2b1)  cache.b2b1  = raw.b2b1;
    log(`[cache] carregado do disco: ODYJS=${cache.odyjs?.issues?.length||0} B2B1=${cache.b2b1?.issues?.length||0}`);
  } catch { log('[cache] sem cache em disco — primeira execução'); }
}

function saveCacheToDisk() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8'); }
  catch(e) { log('[cache] erro ao salvar disco:', e.message); }
}

function isCacheValid(entry) {
  return entry && entry.issues && entry.syncedAt &&
         (Date.now() - new Date(entry.syncedAt).getTime()) < CACHE_TTL;
}

function buildJqlExtra(baseExtra, filters) {
  // filters: { assignees: ['João'], statuses: ['Cancelado'], types: ['Sub-tarefa'] }
  const parts = [];
  if (baseExtra) parts.push(baseExtra);
  if (filters?.assignees?.length) {
    const names = filters.assignees.map(n => `"${n}"`).join(',');
    parts.push(`assignee not in (${names})`);
  }
  if (filters?.statuses?.length) {
    const sts = filters.statuses.map(s => `"${s}"`).join(',');
    parts.push(`status not in (${sts})`);
  }
  if (filters?.types?.length) {
    const ts = filters.types.map(t => `"${t}"`).join(',');
    parts.push(`issuetype not in (${ts})`);
  }
  return parts.join(' AND ');
}

async function refreshCache(key, cfg, jqlExtra = '', incremental = false) {
  if (cache[key]?.updating) return;
  cache[key] = { ...cache[key], updating: true };

  try {
    // ── Sync incremental: só busca issues modificados desde a última sync ──
    if (incremental && cache[key]?.issues?.length > 0 && cache[key]?.syncedAt) {
      // Usa data de ontem como margem de segurança (fuso horário)
      const since = new Date(new Date(cache[key].syncedAt).getTime() - 24*60*60*1000)
                      .toISOString().slice(0,10);
      const deltaJql = `updated >= "${since}"`;
      const fullJql  = jqlExtra ? `${jqlExtra} AND ${deltaJql}` : deltaJql;
      // Mantém o filtro de projeto no incremental
      if (!cfg.project && !cfg.projects) { throw new Error('cfg sem projeto definido'); }
      log(`[cache] ${key} incremental: buscando modificados desde ${since}...`);

      const updated = await fetchAllIssues(cfg, fullJql);
      log(`[cache] ${key} incremental: ${updated.length} issues modificados`);

      if (updated.length > 0) {
        // Merge: substitui os existentes e adiciona novos
        const map = new Map(cache[key].issues.map(i => [i.key, i]));
        updated.forEach(i => map.set(i.key, i));
        const merged = [...map.values()];
        cache[key] = { issues: merged, syncedAt: new Date().toISOString(), updating: false };
        log(`[cache] ${key} merged: ${merged.length} issues total`);
      } else {
        // Nenhuma mudança — só atualiza o timestamp
        cache[key] = { ...cache[key], syncedAt: new Date().toISOString(), updating: false };
        log(`[cache] ${key} sem mudanças detectadas`);
      }
    } else {
      // ── Sync completo (primeira vez ou force) ─────────────────────────────
      log(`[cache] ${key} completo: buscando todos os issues...`);
      const issues = await fetchAllIssues(cfg, jqlExtra);
      cache[key] = { issues, syncedAt: new Date().toISOString(), updating: false };
      log(`[cache] ${key} completo: ${issues.length} issues`);
    }
    saveCacheToDisk();
  } catch(e) {
    cache[key] = { ...cache[key], updating: false };
    log(`[cache] erro ao atualizar ${key}:`, e.message);
  }
}

// Carrega cache do disco ao iniciar (resposta imediata mesmo após restart)
loadCacheFromDisk();

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
    cfg.inactivePersons     = state.inactivePersons     || [];
    cfg.inactiveProjPersons = state.inactiveProjPersons || [];
    cfg.jiraFilters         = state.jiraFilters         || { odyjs: {}, b2b1: {} };
  } catch {
    cfg.inactivePersons     = cfg.inactivePersons     || [];
    cfg.inactiveProjPersons = cfg.inactiveProjPersons || [];
    cfg.jiraFilters         = cfg.jiraFilters         || { odyjs: {}, b2b1: {} };
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

// ── Mapeamento de status do projeto B2B1 ─────────────────────────────────────
const PROJ_STATUS_MAP = {
  // Backlog
  'Backlog':                  'Backlog',
  'To Do':                    'Backlog',
  'Open':                     'Backlog',

  // Iniciação
  'Iniciação':                'Iniciação',
  'Iniciacao':                'Iniciação',
  'Initiation':               'Iniciação',

  // Planejamento
  'Planejamento':             'Planejamento',
  'Planning':                 'Planejamento',

  // Desenvolvimento
  'Desenvolvimento':          'Desenvolvimento',
  'Development':              'Desenvolvimento',
  'In Progress':              'Desenvolvimento',
  'Em Andamento':             'Desenvolvimento',

  // Sign Off
  'Sign Off':                 'Sign Off',
  'Sign off':                 'Sign Off',
  'Signoff':                  'Sign Off',

  // Homologação
  'Homologação':                        'Homologação',
  'Homologacao':                        'Homologação',
  'Homologation':                       'Homologação',
  'In Review':                          'Homologação',
  'UAT':                                'Homologação',
  'Homologação e preparação para Go Live': 'Homologação',

  // Operação Assistida
  'Operação Assistida':       'Operação Assistida',
  'Operacao Assistida':       'Operação Assistida',
  'Assisted Operation':       'Operação Assistida',

  // Aguardando Cliente
  'Aguardando Cliente':       'Aguardando Cliente',
  'Aguardando cliente':       'Aguardando Cliente',
  'Awaiting Customer':        'Aguardando Cliente',
  'Waiting for customer':     'Aguardando Cliente',

  // Bloqueado
  'Bloqueado':                'Bloqueado',
  'Blocked':                  'Bloqueado',
  'Impedido':                 'Bloqueado',

  // Cancelado
  'Cancelado':                'Cancelado',
  'Cancelled':                'Cancelado',
  "Won't Do":                 'Cancelado',
  'Recusado':                 'Cancelado',

  // Concluído
  'Concluído':                'Concluído',
  'Finalizado':               'Concluído',
  'Concluido':                'Concluído',
  'Done':                     'Concluído',
  'Closed':                   'Concluído',
  'Resolved':                 'Concluído',
  'Executed':                 'Concluído',
  'Resolvido':                'Concluído',
};

function mapProjStatus(raw) {
  if (!raw) return 'Backlog';
  if (PROJ_STATUS_MAP[raw]) return PROJ_STATUS_MAP[raw];
  for (const [k, v] of Object.entries(PROJ_STATUS_MAP))
    if (k.toLowerCase() === raw.toLowerCase()) return v;
  log(`  [B2B1] status não mapeado: "${raw}" → mantendo original`);
  return raw; // mantém o status original se não mapeado
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

function parseIssue(i, domain, statusFn = mapStatus) {
  const f = i.fields || {};
  const sp = f.customfield_10016 ?? f.customfield_10028 ?? null;
  return {
    key: i.key, summary: (f.summary || '').trim(),
    rawStatus: f.status?.name || '', status: statusFn(f.status?.name),
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
  // Suporta múltiplos projetos: cfg.projects = ['B2B1','B2C'] ou cfg.project = 'B2B1'
  const projectClause = Array.isArray(cfg.projects) && cfg.projects.length > 1
    ? `project in (${cfg.projects.map(p => `"${p}"`).join(',')})`
    : `project = "${cfg.project}"`;
  const base = projectClause + (jqlExtra ? ` AND ${jqlExtra}` : '');
  const jql  = encodeURIComponent(base + ' ORDER BY created DESC');
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
        return all.map(i => parseIssue(i, cfg.domain, cfg.statusFn || mapStatus));
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
  return all.map(i => parseIssue(i, cfg.domain, cfg.statusFn || mapStatus));
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
  const reqUrl  = new URL(req.url, 'http://localhost');
  const pathname = reqUrl.pathname;
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
    const cfg   = loadConfig();
    const force = new URL(req.url, 'http://localhost').searchParams.get('force') === '1';
    if (!cfg.email || !cfg.token) { json(res, 401, { error: 'Não configurado.' }); return; }

    if (!force && isCacheValid(cache.odyjs)) {
      log(`[cache] ODYJS: servindo ${cache.odyjs.issues.length} issues do cache`);
      const age = Date.now() - new Date(cache.odyjs.syncedAt).getTime();
      // Background incremental: só busca o que mudou
      const odyjsFilters = (loadConfig().jiraFilters || {}).odyjs || {};
      const odyjsJql1 = buildJqlExtra('created >= "2025-01-01"', odyjsFilters);
      if (age > CACHE_TTL * 0.8) refreshCache('odyjs', cfg, odyjsJql1, true).catch(()=>{});
      json(res, 200, { ok: true, total: cache.odyjs.issues.length, issues: cache.odyjs.issues,
        syncedAt: cache.odyjs.syncedAt, fromCache: true });
      return;
    }

    log(`[cache] ODYJS: buscando do Jira (${force?'completo forçado':'cache expirado'})...`);
    try {
      // force=true → sync completo | expirado sem force → incremental
      const odyjsFilters2 = (loadConfig().jiraFilters || {}).odyjs || {};
      const odyjsJql2 = buildJqlExtra('created >= "2025-01-01"', odyjsFilters2);
      await refreshCache('odyjs', cfg, odyjsJql2, !force);
      const entry = cache.odyjs;
      json(res, 200, { ok: true, total: entry.issues.length, issues: entry.issues,
        syncedAt: entry.syncedAt, fromCache: false });
    } catch(e) {
      log('Erro issues:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/proj-issues — busca issues do projeto Projetos (configurável via query param)
  if (pathname === '/api/proj-issues' && req.method === 'GET') {
    const cfg     = loadConfig();
    const reqUrlP = new URL(req.url, 'http://localhost');
    const projKey = reqUrlP.searchParams.get('project') || 'B2B1';
    const force   = reqUrlP.searchParams.get('force') === '1';
    if (!cfg.email || !cfg.token) { json(res, 401, { error: 'Não configurado.' }); return; }

    // Serve do cache se válido
    if (!force && isCacheValid(cache.b2b1)) {
      log(`[cache] B2B1: servindo ${cache.b2b1.issues.length} issues do cache`);
      const age = Date.now() - new Date(cache.b2b1.syncedAt).getTime();
      if (age > CACHE_TTL * 0.8) {
        const projCfg = { ...cfg, project: projKey, projects: ['B2B1', 'B2C'], statusFn: mapProjStatus };
        const b2b1Filters1 = (loadConfig().jiraFilters || {}).b2b1 || {};
        const b2b1Jql1 = buildJqlExtra('created >= "2025-01-01"', b2b1Filters1);
        refreshCache('b2b1', projCfg, b2b1Jql1, true).catch(()=>{});
      }
      json(res, 200, { ok: true, total: cache.b2b1.issues.length, issues: cache.b2b1.issues,
        syncedAt: cache.b2b1.syncedAt, fromCache: true });
      return;
    }

    log(`[cache] B2B1: buscando do Jira (${force?'completo forçado':'cache expirado'})...`);
    try {
      const projCfg = { ...cfg, project: projKey, projects: ['B2B1', 'B2C'], statusFn: mapProjStatus };
      const b2b1Filters2 = (loadConfig().jiraFilters || {}).b2b1 || {};
      const b2b1Jql2 = buildJqlExtra('created >= "2025-01-01"', b2b1Filters2);
      await refreshCache('b2b1', projCfg, b2b1Jql2, !force);
      const entry = cache.b2b1;
      json(res, 200, { ok: true, total: entry.issues.length, issues: entry.issues,
        syncedAt: entry.syncedAt, fromCache: false });
    } catch(e) {
      log('Erro proj-issues:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/cache-status — informa estado do cache de ambos os módulos
  if (pathname === '/api/cache-status') {
    const now = Date.now();
    const info = (entry) => entry ? {
      count:     entry.issues?.length || 0,
      syncedAt:  entry.syncedAt || null,
      ageMs:     entry.syncedAt ? now - new Date(entry.syncedAt).getTime() : null,
      valid:     isCacheValid(entry),
      updating:  entry.updating || false,
      mode:      entry.issues?.length > 0 ? 'incremental disponível' : 'sync completo necessário',
    } : { count: 0, syncedAt: null, ageMs: null, valid: false, updating: false, mode: 'sem dados' };
    json(res, 200, { odyjs: info(cache.odyjs), b2b1: info(cache.b2b1), ttlMs: CACHE_TTL });
    return;
  }

  // GET /api/jira-filters — retorna filtros de exclusão do Jira
  if (pathname === '/api/jira-filters' && req.method === 'GET') {
    const cfg = loadConfig();
    json(res, 200, { filters: cfg.jiraFilters || { odyjs: {}, b2b1: {} } });
    return;
  }

  // POST /api/jira-filters — salva filtros e invalida o cache para refetch
  if (pathname === '/api/jira-filters' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.filters || typeof b.filters !== 'object') {
      json(res, 400, { error: 'Campo "filters" inválido.' }); return;
    }
    const stateFile = path.join(__dirname, 'state.json');
    try {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      state.jiraFilters = b.filters;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
      // Invalida o cache para forçar refetch com novos filtros
      cache.odyjs = null;
      cache.b2b1  = null;
      saveCacheToDisk();
      log('[filtros] salvos e cache invalidado');
    } catch(e) {
      log('[filtros] erro ao salvar:', e.message);
    }
    json(res, 200, { ok: true });
    return;
  }

  // GET /api/inactive-proj — retorna lista de pessoas inativas do módulo Projetos
  if (pathname === '/api/inactive-proj' && req.method === 'GET') {
    const cfg = loadConfig();
    json(res, 200, { inactive: cfg.inactiveProjPersons || [] });
    return;
  }

  // POST /api/inactive-proj — salva lista de pessoas inativas do módulo Projetos
  if (pathname === '/api/inactive-proj' && req.method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.inactive)) {
      json(res, 400, { error: 'Campo "inactive" deve ser um array.' }); return;
    }
    const stateFile = path.join(__dirname, 'state.json');
    try {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      state.inactiveProjPersons = b.inactive;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch(e) {
      log('Aviso: não foi possível salvar state.json (proj):', e.message);
    }
    if (!IS_CLOUD) {
      try {
        const cfg = loadConfig();
        cfg.inactiveProjPersons = b.inactive;
        saveConfig(cfg);
      } catch {}
    }
    json(res, 200, { ok: true, inactive: b.inactive });
    return;
  }

  // GET /api/inactive — retorna lista de pessoas inativas do módulo Orçamento
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

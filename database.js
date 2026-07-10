const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'vigilancia.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === CREATE TABLES ===
db.exec(`
  -- Usuarios do sistema
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nome TEXT,
    perfil TEXT DEFAULT 'admin',
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now')),
    ultimo_login TEXT
  );

  -- Notificacoes de arboviroses (dados do SINAN .dbf)
  CREATE TABLE IF NOT EXISTS notificacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nu_notific TEXT,
    agravo TEXT NOT NULL,           -- 'dengue' ou 'chikungunya'
    dt_notific TEXT,
    dt_sin_pri TEXT,
    sem_pri TEXT,
    nm_paciente TEXT,
    dt_nasc TEXT,
    idade INTEGER,
    cs_sexo TEXT,
    nm_bairro TEXT,
    nm_logrado TEXT,
    nu_numero TEXT,
    classi_fin TEXT,
    criterio TEXT,
    evolucao TEXT,
    hospitaliz TEXT,
    dt_obito TEXT,
    febre TEXT,
    mialgia TEXT,
    cefaleia TEXT,
    artralgia TEXT,
    exantema TEXT,
    vomito TEXT,
    nausea TEXT,
    dor_retro TEXT,
    conjuntvit TEXT,
    diabetes TEXT,
    hipertensa TEXT,
    sorotipo TEXT,
    resul_pcr TEXT,
    resul_soro TEXT,
    dt_encerra TEXT,
    importado_em TEXT DEFAULT (datetime('now')),
    arquivo_origem TEXT
  );

  -- Pontos de EDL (Estacoes Disseminadoras de Larvicida)
  CREATE TABLE IF NOT EXISTS edls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria TEXT NOT NULL,        -- 'pe' (ponto estrategico) ou 'residencial'
    nome TEXT,
    endereco TEXT,
    bairro TEXT,
    latitude REAL,
    longitude REAL,
    importado_em TEXT DEFAULT (datetime('now')),
    arquivo_origem TEXT
  );

  -- Historico de uploads
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT,
    categoria TEXT,
    tamanho INTEGER,
    registros_processados INTEGER DEFAULT 0,
    status TEXT DEFAULT 'processando',  -- 'processando', 'concluido', 'erro'
    mensagem TEXT,
    usuario TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  -- Cache de dados agregados para o dashboard
  CREATE TABLE IF NOT EXISTS cache_dashboard (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    atualizado_em TEXT DEFAULT (datetime('now'))
  );

  -- Indices para performance
  CREATE INDEX IF NOT EXISTS idx_notif_agravo ON notificacoes(agravo);
  CREATE INDEX IF NOT EXISTS idx_notif_bairro ON notificacoes(nm_bairro);
  CREATE INDEX IF NOT EXISTS idx_notif_dt ON notificacoes(dt_sin_pri);
  CREATE INDEX IF NOT EXISTS idx_notif_classi ON notificacoes(classi_fin);
  CREATE INDEX IF NOT EXISTS idx_notif_nu ON notificacoes(nu_notific, agravo);
  CREATE INDEX IF NOT EXISTS idx_edl_cat ON edls(categoria);
  CREATE INDEX IF NOT EXISTS idx_edl_bairro ON edls(bairro);
`);

// === PREPARED STATEMENTS ===

const stmts = {
  // Notificacoes
  insertNotificacao: db.prepare(`
    INSERT INTO notificacoes (nu_notific, agravo, dt_notific, dt_sin_pri, sem_pri, 
      nm_paciente, dt_nasc, idade, cs_sexo, nm_bairro, nm_logrado, nu_numero,
      classi_fin, criterio, evolucao, hospitaliz, dt_obito, febre, mialgia, 
      cefaleia, artralgia, exantema, vomito, nausea, dor_retro, conjuntvit,
      diabetes, hipertensa, sorotipo, resul_pcr, resul_soro, dt_encerra, arquivo_origem)
    VALUES (@nu_notific, @agravo, @dt_notific, @dt_sin_pri, @sem_pri,
      @nm_paciente, @dt_nasc, @idade, @cs_sexo, @nm_bairro, @nm_logrado, @nu_numero,
      @classi_fin, @criterio, @evolucao, @hospitaliz, @dt_obito, @febre, @mialgia,
      @cefaleia, @artralgia, @exantema, @vomito, @nausea, @dor_retro, @conjuntvit,
      @diabetes, @hipertensa, @sorotipo, @resul_pcr, @resul_soro, @dt_encerra, @arquivo_origem)
  `),

  // EDLs
  insertEdl: db.prepare(`
    INSERT INTO edls (categoria, nome, endereco, bairro, latitude, longitude, arquivo_origem)
    VALUES (@categoria, @nome, @endereco, @bairro, @latitude, @longitude, @arquivo_origem)
  `),

  // Uploads
  insertUpload: db.prepare(`
    INSERT INTO uploads (filename, original_name, categoria, tamanho, usuario)
    VALUES (@filename, @original_name, @categoria, @tamanho, @usuario)
  `),
  updateUpload: db.prepare(`
    UPDATE uploads SET status = @status, registros_processados = @registros, mensagem = @mensagem
    WHERE id = @id
  `),

  // Cache
  setCache: db.prepare(`
    INSERT OR REPLACE INTO cache_dashboard (chave, valor, atualizado_em)
    VALUES (@chave, @valor, datetime('now'))
  `),
  getCache: db.prepare(`SELECT valor FROM cache_dashboard WHERE chave = ?`),

  // Queries
  countNotificacoes: db.prepare(`SELECT COUNT(*) as total FROM notificacoes WHERE agravo = ?`),
  countEdls: db.prepare(`SELECT COUNT(*) as total FROM edls WHERE categoria = ?`),

  // Limpar dados de uma categoria (para reimportacao)
  clearNotificacoes: db.prepare(`DELETE FROM notificacoes WHERE agravo = ?`),
  clearEdls: db.prepare(`DELETE FROM edls WHERE categoria = ?`),
};

// === FUNCTIONS ===

/**
 * Importa registros de notificacao em batch (transacao)
 */
function importarNotificacoes(records, agravo, arquivoOrigem) {
  const insertMany = db.transaction((recs) => {
    // Limpa dados anteriores do mesmo agravo
    stmts.clearNotificacoes.run(agravo);

    let count = 0;
    for (const rec of recs) {
      const idade = parseIdade(rec.NU_IDADE_N);
      stmts.insertNotificacao.run({
        nu_notific: clean(rec.NU_NOTIFIC),
        agravo,
        dt_notific: cleanDate(rec.DT_NOTIFIC),
        dt_sin_pri: cleanDate(rec.DT_SIN_PRI),
        sem_pri: clean(rec.SEM_PRI),
        nm_paciente: clean(rec.NM_PACIENT),
        dt_nasc: cleanDate(rec.DT_NASC),
        idade,
        cs_sexo: clean(rec.CS_SEXO),
        nm_bairro: clean(rec.NM_BAIRRO),
        nm_logrado: clean(rec.NM_LOGRADO),
        nu_numero: clean(rec.NU_NUMERO),
        classi_fin: clean(rec.CLASSI_FIN),
        criterio: clean(rec.CRITERIO),
        evolucao: clean(rec.EVOLUCAO),
        hospitaliz: clean(rec.HOSPITALIZ),
        dt_obito: cleanDate(rec.DT_OBITO),
        febre: clean(rec.FEBRE),
        mialgia: clean(rec.MIALGIA),
        cefaleia: clean(rec.CEFALEIA),
        artralgia: clean(rec.ARTRALGIA),
        exantema: clean(rec.EXANTEMA),
        vomito: clean(rec.VOMITO),
        nausea: clean(rec.NAUSEA),
        dor_retro: clean(rec.DOR_RETRO),
        conjuntvit: clean(rec.CONJUNTVIT),
        diabetes: clean(rec.DIABETES),
        hipertensa: clean(rec.HIPERTENSA),
        sorotipo: clean(rec.SOROTIPO),
        resul_pcr: clean(rec.RESUL_PCR_),
        resul_soro: clean(rec.RESUL_SORO),
        dt_encerra: cleanDate(rec.DT_ENCERRA),
        arquivo_origem: arquivoOrigem
      });
      count++;
    }
    return count;
  });

  return insertMany(records);
}

/**
 * Importa pontos EDL em batch
 */
function importarEdls(points, categoria, arquivoOrigem) {
  const insertMany = db.transaction((pts) => {
    stmts.clearEdls.run(categoria);

    let count = 0;
    for (const pt of pts) {
      stmts.insertEdl.run({
        categoria,
        nome: pt.name || '',
        endereco: pt.address || pt.name || '',
        bairro: pt.bairro || extrairBairro(pt.name || ''),
        latitude: pt.lat || null,
        longitude: pt.lon || null,
        arquivo_origem: arquivoOrigem
      });
      count++;
    }
    return count;
  });

  return insertMany(points);
}

/**
 * Gera dados agregados para o dashboard (salva no cache)
 */
function gerarDadosDashboard() {
  // Dados por bairro
  const bairroQuery = db.prepare(`
    SELECT 
      nm_bairro as bairro,
      agravo,
      COUNT(*) as notif,
      SUM(CASE WHEN (agravo='dengue' AND classi_fin='10') OR (agravo='chikungunya' AND classi_fin='13') THEN 1 ELSE 0 END) as conf,
      SUM(CASE WHEN hospitaliz='1' THEN 1 ELSE 0 END) as hosp,
      SUM(CASE WHEN evolucao='2' THEN 1 ELSE 0 END) as obitos
    FROM notificacoes
    GROUP BY nm_bairro, agravo
  `);

  // Dados mensais por bairro
  const monthQuery = db.prepare(`
    SELECT 
      nm_bairro as bairro,
      agravo,
      SUBSTR(dt_sin_pri, 5, 2) as mes,
      COUNT(*) as notif,
      SUM(CASE WHEN (agravo='dengue' AND classi_fin='10') OR (agravo='chikungunya' AND classi_fin='13') THEN 1 ELSE 0 END) as conf
    FROM notificacoes
    WHERE LENGTH(dt_sin_pri) = 8 
      AND SUBSTR(dt_sin_pri, 5, 2) BETWEEN '01' AND '12'
    GROUP BY nm_bairro, agravo, SUBSTR(dt_sin_pri, 5, 2)
  `);

  // Curva epidemica por semana
  const curveQuery = db.prepare(`
    SELECT sem_pri as semana, agravo, COUNT(*) as casos
    FROM notificacoes
    WHERE sem_pri LIKE '2026%'
    GROUP BY sem_pri, agravo
    ORDER BY sem_pri
  `);

  // Totais
  const totaisQuery = db.prepare(`
    SELECT 
      agravo,
      COUNT(*) as notif,
      SUM(CASE WHEN (agravo='dengue' AND classi_fin='10') OR (agravo='chikungunya' AND classi_fin='13') THEN 1 ELSE 0 END) as conf,
      SUM(CASE WHEN hospitaliz='1' THEN 1 ELSE 0 END) as hosp,
      SUM(CASE WHEN evolucao='2' THEN 1 ELSE 0 END) as obitos
    FROM notificacoes
    GROUP BY agravo
  `);

  // EDLs
  const edlQuery = db.prepare(`
    SELECT id, categoria, nome, bairro, latitude, longitude FROM edls
  `);

  // Build dashboard object
  const bairros = {};
  for (const row of bairroQuery.all()) {
    const b = row.bairro || 'NAO INFORMADO';
    if (!bairros[b]) bairros[b] = { total: { dengue_not: 0, dengue_conf: 0, chik_not: 0, chik_conf: 0, hosp: 0, obitos: 0 }, months: {} };
    if (row.agravo === 'dengue') {
      bairros[b].total.dengue_not = row.notif;
      bairros[b].total.dengue_conf = row.conf;
    } else {
      bairros[b].total.chik_not = row.notif;
      bairros[b].total.chik_conf = row.conf;
    }
    bairros[b].total.hosp += row.hosp;
    bairros[b].total.obitos += row.obitos;
  }

  // Monthly data
  for (const row of monthQuery.all()) {
    const b = row.bairro || 'NAO INFORMADO';
    if (!bairros[b]) continue;
    if (!bairros[b].months[row.mes]) bairros[b].months[row.mes] = { d_n: 0, d_c: 0, c_n: 0, c_c: 0 };
    if (row.agravo === 'dengue') {
      bairros[b].months[row.mes].d_n = row.notif;
      bairros[b].months[row.mes].d_c = row.conf;
    } else {
      bairros[b].months[row.mes].c_n = row.notif;
      bairros[b].months[row.mes].c_c = row.conf;
    }
  }

  // Curve data
  const curve = { dengue: {}, chikungunya: {} };
  for (const row of curveQuery.all()) {
    curve[row.agravo][row.semana] = row.casos;
  }

  // Totals
  const meta = {};
  for (const row of totaisQuery.all()) {
    meta[row.agravo] = { notif: row.notif, conf: row.conf, hosp: row.hosp, obitos: row.obitos };
  }

  // EDLs
  const edls = edlQuery.all();

  const dashboard = {
    meta,
    bairros,
    curve,
    edls,
    updated: new Date().toISOString()
  };

  // Save to cache
  stmts.setCache.run({ chave: 'dashboard', valor: JSON.stringify(dashboard) });

  return dashboard;
}

/**
 * Retorna dados do dashboard (do cache ou gera)
 */
function getDashboardData() {
  const cached = stmts.getCache.get('dashboard');
  if (cached) return JSON.parse(cached.valor);
  return gerarDadosDashboard();
}

/**
 * Estatisticas gerais
 */
function getStats() {
  const dengue = stmts.countNotificacoes.get('dengue');
  const chik = stmts.countNotificacoes.get('chikungunya');
  const edlPe = stmts.countEdls.get('pe');
  const edlRes = stmts.countEdls.get('residencial');
  const uploads = db.prepare(`SELECT * FROM uploads ORDER BY criado_em DESC LIMIT 20`).all();
  const lastUpdate = db.prepare(`SELECT atualizado_em FROM cache_dashboard WHERE chave = 'dashboard'`).get();

  return {
    dengue: dengue.total,
    chikungunya: chik.total,
    edl_pe: edlPe.total,
    edl_residencial: edlRes.total,
    total_notificacoes: dengue.total + chik.total,
    lastUpdate: lastUpdate ? lastUpdate.atualizado_em : null,
    uploads
  };
}

// === HELPERS ===

function clean(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function cleanDate(val) {
  if (!val) return '';
  
  // Se for objeto Date (dbffile retorna Date para campos tipo D)
  if (val instanceof Date && !isNaN(val.getTime())) {
    // Usar UTC para evitar problemas de timezone
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    if (y >= 1990 && y <= 2030) return `${y}${m}${d}`;
    return '';
  }
  
  // Se for string
  let s = String(val).trim();
  
  // Formato ISO: 2026-03-10T00:00:00.000Z ou 2026-03-10
  if (s.includes('T') || (s.includes('-') && s.length >= 10)) {
    try {
      const dt = new Date(s);
      if (!isNaN(dt.getTime())) {
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const d2 = String(dt.getUTCDate()).padStart(2, '0');
        if (y >= 1990 && y <= 2030) return `${y}${m}${d2}`;
      }
    } catch {}
  }
  
  // Remover separadores
  s = s.replace(/[-\/\.]/g, '');
  
  // Se tem 8 digitos numericos
  if (s.length === 8 && /^\d{8}$/.test(s)) return s;
  
  // Tentar extrair 8 digitos
  const match = s.match(/(\d{8})/);
  if (match) return match[1];
  
  return '';
}

function parseIdade(val) {
  if (!val) return null;
  try {
    const num = parseInt(val);
    if (num >= 4000) return num - 4000;
    if (num >= 3000) return Math.round((num - 3000) / 12);
    return null;
  } catch { return null; }
}

function extrairBairro(name) {
  if (!name) return '';
  if (name.includes('Bairro ')) {
    const parts = name.split('Bairro ');
    if (parts[1]) return parts[1].split(',')[0].trim();
  }
  if (name.includes('Distrito Industrial')) return 'Distrito Industrial';
  if (name.includes('Centro')) return 'Centro';
  return '';
}

module.exports = {
  db,
  importarNotificacoes,
  importarEdls,
  gerarDadosDashboard,
  getDashboardData,
  getStats,
  stmts
};

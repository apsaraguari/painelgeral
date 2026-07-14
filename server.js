const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { DBFFile } = require('dbffile');
const JSZip = require('jszip');
const { importarNotificacoes, importarEdls, gerarDadosDashboard, getDashboardData, getStats, stmts, db } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'araguari-vigilancia-2026-secret';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Default admin credentials (change via env)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS_HASH = bcrypt.hashSync(process.env.ADMIN_PASS || 'araguari2026', 10);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Multer config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `${ts}-${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nao autorizado' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido' });
  }
}

// === ROUTES ===

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && bcrypt.compareSync(password, ADMIN_PASS_HASH)) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, { httpOnly: true, maxAge: 86400000 });
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Credenciais invalidas' });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Check auth
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

// Upload file
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const originalNameLower = originalName.toLowerCase();
  const category = req.body.category || 'geral';

  // Register upload
  const uploadInfo = stmts.insertUpload.run({
    filename: req.file.filename,
    original_name: originalName,
    categoria: category,
    tamanho: req.file.size,
    usuario: req.user.username
  });
  const uploadId = uploadInfo.lastInsertRowid;

  try {
    let result;
    if (originalNameLower.endsWith('.dbf')) {
      result = await processDBF(filePath, category, originalName);
    } else if (originalNameLower.endsWith('.kmz')) {
      result = await processKMZ(filePath, category, originalName);
    } else {
      stmts.updateUpload.run({ id: uploadId, status: 'erro', registros: 0, mensagem: 'Formato nao suportado' });
      return res.status(400).json({ error: 'Formato nao suportado. Use .dbf ou .kmz' });
    }

    // Update upload status
    stmts.updateUpload.run({ id: uploadId, status: 'concluido', registros: result.count, mensagem: result.message });

    // Regenerate dashboard cache
    gerarDadosDashboard();

    res.json({ success: true, message: result.message, stats: result.stats });
  } catch (err) {
    console.error('Erro ao processar:', err);
    stmts.updateUpload.run({ id: uploadId, status: 'erro', registros: 0, mensagem: err.message });
    res.status(500).json({ error: `Erro ao processar arquivo: ${err.message}` });
  }
});

// Get current data status
app.get('/api/status', authMiddleware, (req, res) => {
  const stats = getStats();
  res.json(stats);
});

// Get dashboard data (public)
app.get('/api/data', (req, res) => {
  const data = getDashboardData();
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: 'Dados nao encontrados. Faca upload dos arquivos.' });
  }
});

// Debug: check raw date data
app.get('/api/debug/dates', authMiddleware, (req, res) => {
  const sample = db.prepare(`
    SELECT dt_sin_pri, COUNT(*) as qty 
    FROM notificacoes 
    WHERE dt_sin_pri != '' 
    GROUP BY dt_sin_pri 
    ORDER BY qty DESC 
    LIMIT 20
  `).all();
  const months = db.prepare(`
    SELECT SUBSTR(dt_sin_pri, 5, 2) as mes, COUNT(*) as qty 
    FROM notificacoes 
    WHERE LENGTH(dt_sin_pri) = 8 
    GROUP BY SUBSTR(dt_sin_pri, 5, 2)
    ORDER BY mes
  `).all();
  const total = db.prepare(`SELECT COUNT(*) as total FROM notificacoes`).get();
  const withDate = db.prepare(`SELECT COUNT(*) as total FROM notificacoes WHERE LENGTH(dt_sin_pri) = 8`).get();
  const noDate = db.prepare(`SELECT COUNT(*) as total FROM notificacoes WHERE dt_sin_pri = '' OR dt_sin_pri IS NULL`).get();
  res.json({ total: total.total, withDate8: withDate.total, noDate: noDate.total, sampleDates: sample, monthlyDistrib: months });
});

// Delete upload record
app.delete('/api/upload/:id', authMiddleware, (req, res) => {
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
  if (!upload) return res.status(404).json({ error: 'Upload nao encontrado' });

  // Delete file if exists
  const filePath = path.join(UPLOAD_DIR, upload.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM uploads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Limpar dados por categoria
app.post('/api/limpar', authMiddleware, (req, res) => {
  const { categoria } = req.body;

  if (categoria === 'dengue') {
    stmts.clearNotificacoes.run('dengue');
    gerarDadosDashboard();
    res.json({ success: true, message: 'Dados de Dengue apagados' });
  } else if (categoria === 'chikungunya') {
    stmts.clearNotificacoes.run('chikungunya');
    gerarDadosDashboard();
    res.json({ success: true, message: 'Dados de Chikungunya apagados' });
  } else if (categoria === 'edl_pe') {
    stmts.clearEdls.run('pe');
    gerarDadosDashboard();
    res.json({ success: true, message: 'EDLs Pontos Estrategicos apagados' });
  } else if (categoria === 'edl_residencial') {
    stmts.clearEdls.run('residencial');
    gerarDadosDashboard();
    res.json({ success: true, message: 'EDLs Residenciais apagados' });
  } else if (categoria === 'tudo') {
    stmts.clearNotificacoes.run('dengue');
    stmts.clearNotificacoes.run('chikungunya');
    stmts.clearEdls.run('pe');
    stmts.clearEdls.run('residencial');
    db.prepare('DELETE FROM uploads').run();
    db.prepare('DELETE FROM cache_dashboard').run();
    gerarDadosDashboard();
    res.json({ success: true, message: 'Todos os dados foram apagados' });
  } else {
    res.status(400).json({ error: 'Categoria invalida' });
  }
});

// === PROCESSING FUNCTIONS ===

async function processDBF(filePath, category, originalName) {
  const dbf = await DBFFile.open(filePath);
  const records = await dbf.readRecords(dbf.recordCount);

  // Debug: log date handling
  for (let i = 0; i < Math.min(5, records.length); i++) {
    const raw = records[i].DT_SIN_PRI;
    const type = raw instanceof Date ? 'Date' : typeof raw;
    let preview = '';
    if (raw instanceof Date && !isNaN(raw.getTime())) {
      preview = `${raw.getUTCFullYear()}${String(raw.getUTCMonth()+1).padStart(2,'0')}${String(raw.getUTCDate()).padStart(2,'0')}`;
    } else {
      preview = String(raw || '').substring(0, 20);
    }
    console.log(`[DBF] rec[${i}] DT_SIN_PRI: type=${type} -> "${preview}"`);
  }

  const count = importarNotificacoes(records, category, originalName);

  // Verify dates were saved
  const check = db.prepare(`SELECT dt_sin_pri, COUNT(*) as qty FROM notificacoes WHERE agravo=? AND dt_sin_pri != '' GROUP BY dt_sin_pri ORDER BY qty DESC LIMIT 5`).all(category);
  console.log(`[DBF] Top dates in DB for ${category}:`, JSON.stringify(check));
  const emptyDates = db.prepare(`SELECT COUNT(*) as qty FROM notificacoes WHERE agravo=? AND (dt_sin_pri = '' OR dt_sin_pri IS NULL)`).get(category);
  console.log(`[DBF] Empty dates for ${category}: ${emptyDates.qty}`);

  return {
    count,
    message: `${category}: ${count} registros importados no banco de dados`,
    stats: { records: count, category }
  };
}

async function processKMZ(filePath, category, originalName) {
  const fileBuffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(fileBuffer);

  let kmlContent = null;
  for (const [name, file] of Object.entries(zip.files)) {
    if (name.endsWith('.kml')) {
      kmlContent = await file.async('string');
      break;
    }
  }

  if (!kmlContent) throw new Error('Nenhum arquivo KML encontrado no KMZ');

  const points = [];
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  const nameRegex = /<name>([\s\S]*?)<\/name>/;
  const coordsRegex = /<coordinates>([\s\S]*?)<\/coordinates>/;

  let match;
  while ((match = placemarkRegex.exec(kmlContent)) !== null) {
    const content = match[1];
    const nameMatch = nameRegex.exec(content);
    const coordMatch = coordsRegex.exec(content);

    const name = nameMatch ? nameMatch[1].trim() : '';
    let lat = null, lon = null;
    if (coordMatch) {
      const parts = coordMatch[1].trim().split(',');
      if (parts.length >= 2) {
        lon = parseFloat(parts[0]);
        lat = parseFloat(parts[1]);
      }
    }

    const bairro = extrairBairroNome(name);
    points.push({ name, address: name, lat, lon, bairro });
  }

  // Salva pontos no banco (sem coordenadas por enquanto para quem nao tem)
  const count = importarEdls(points, category, originalName);

  // Inicia geocodificacao em background
  geocodificarBackground(category);

  return {
    count,
    message: `KMZ (${category}): ${count} pontos importados. Geocodificacao em andamento...`,
    stats: { points: count, withCoords: points.filter(p => p.lat).length }
  };
}

// Geocodificacao em background (nao bloqueia o upload)
async function geocodificarBackground(category) {
  const https = require('https');
  
  // Busca pontos sem coordenadas
  const pontosSemCoord = db.prepare(`
    SELECT id, nome, endereco FROM edls 
    WHERE categoria = ? AND (latitude IS NULL OR latitude = 0)
  `).all(category);

  if (pontosSemCoord.length === 0) {
    console.log(`[GEO] ${category}: todos os pontos ja tem coordenadas`);
    return;
  }

  console.log(`[GEO] Iniciando geocodificacao de ${pontosSemCoord.length} pontos (${category})...`);

  const updateCoord = db.prepare(`UPDATE edls SET latitude = ?, longitude = ?, bairro = ? WHERE id = ?`);
  const streetCache = {};
  let geocoded = 0;
  let failed = 0;

  for (const ponto of pontosSemCoord) {
    const street = (ponto.nome || ponto.endereco || '').split(',')[0].trim();
    const query = street + ', Araguari, MG, Brazil';

    // Cache por rua
    if (streetCache[street]) {
      const base = streetCache[street];
      const lat = base.lat + (Math.random() - 0.5) * 0.001;
      const lon = base.lon + (Math.random() - 0.5) * 0.001;
      const bairro = extrairBairroNome(ponto.nome || '');
      updateCoord.run(lat, lon, bairro, ponto.id);
      geocoded++;
      continue;
    }

    try {
      const coords = await nominatimGeocode(query, https);
      if (coords) {
        streetCache[street] = coords;
        const bairro = extrairBairroNome(ponto.nome || '');
        updateCoord.run(coords.lat, coords.lon, bairro, ponto.id);
        geocoded++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }

    // Rate limit: 1 request/sec (Nominatim policy)
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`[GEO] ${category} concluido: ${geocoded} geocodificados, ${failed} falharam`);

  // Regenera dashboard com coordenadas atualizadas
  gerarDadosDashboard();
  console.log(`[GEO] Dashboard atualizado com novas coordenadas`);
}

function nominatimGeocode(query, https) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const options = { headers: { 'User-Agent': 'PainelVigilanciaAraguari/1.0 (aps@araguari.mg.gov.br)' } };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results && results.length > 0) {
            resolve({ lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function extrairBairroNome(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  if (lower.includes('bairro ')) {
    const parts = name.split(/bairro /i);
    if (parts[1]) return parts[1].split(',')[0].trim();
  }
  if (lower.includes('distrito industrial')) return 'Distrito Industrial';
  if (lower.includes('centro')) return 'Centro';
  if (lower.includes('industrial')) return 'Industrial';
  return '';
}

// Endpoint para verificar progresso da geocodificacao
app.get('/api/geocode-status', authMiddleware, (req, res) => {
  const total = db.prepare(`SELECT COUNT(*) as t FROM edls`).get().t;
  const comCoord = db.prepare(`SELECT COUNT(*) as t FROM edls WHERE latitude IS NOT NULL AND latitude != 0`).get().t;
  const semCoord = db.prepare(`SELECT COUNT(*) as t FROM edls WHERE latitude IS NULL OR latitude = 0`).get().t;
  res.json({ total, comCoord, semCoord, percentual: total > 0 ? Math.round(comCoord / total * 100) : 0 });
});

// Listar EDLs para edicao
app.get('/api/edls', authMiddleware, (req, res) => {
  const cat = req.query.categoria || '';
  const search = req.query.search || '';
  let query = `SELECT id, categoria, nome, bairro, latitude, longitude FROM edls WHERE 1=1`;
  const params = [];
  if (cat) { query += ` AND categoria = ?`; params.push(cat); }
  if (search) { query += ` AND nome LIKE ?`; params.push(`%${search}%`); }
  query += ` ORDER BY nome LIMIT 100`;
  const edls = db.prepare(query).all(...params);
  res.json(edls);
});

// Atualizar coordenadas de um EDL
app.put('/api/edls/:id', authMiddleware, (req, res) => {
  const { latitude, longitude, bairro } = req.body;
  const id = req.params.id;
  if (latitude === undefined || longitude === undefined) return res.status(400).json({ error: 'Latitude e longitude obrigatorios' });
  db.prepare(`UPDATE edls SET latitude = ?, longitude = ?, bairro = ? WHERE id = ?`).run(latitude, longitude, bairro || '', id);
  // Regenera dashboard
  gerarDadosDashboard();
  res.json({ success: true });
});

// === ATENCAO PRIMARIA ROUTES ===
const { stmtsAPS, INDICADORES_APS } = require('./database');

// Lista indicadores disponiveis
app.get('/api/aps/indicadores', authMiddleware, (req, res) => {
  res.json(INDICADORES_APS);
});

// Lista unidades de saude
app.get('/api/aps/unidades', authMiddleware, (req, res) => {
  const unidades = stmtsAPS.listUnidades.all();
  res.json(unidades);
});

// Criar unidade
app.post('/api/aps/unidades', authMiddleware, (req, res) => {
  const { nome, tipo } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  stmtsAPS.insertUnidade.run(nome.trim(), tipo || 'UBS');
  res.json({ success: true, unidades: stmtsAPS.listUnidades.all() });
});

// Deletar unidade
app.delete('/api/aps/unidades/:id', authMiddleware, (req, res) => {
  stmtsAPS.deleteUnidade.run(req.params.id);
  res.json({ success: true });
});

// Salvar indicadores de uma unidade
app.post('/api/aps/indicadores', authMiddleware, (req, res) => {
  const { unidade_id, competencia, dados } = req.body;
  if (!unidade_id || !competencia || !dados) return res.status(400).json({ error: 'Dados incompletos' });

  const saveMany = db.transaction((items) => {
    for (const item of items) {
      stmtsAPS.upsertIndicador.run({
        unidade_id,
        competencia,
        indicador: item.indicador,
        numerador: item.numerador || 0,
        denominador: item.denominador || 0,
        meta: item.meta || 0,
        valor_alcancado: item.denominador > 0 ? ((item.numerador / item.denominador) * 100) : 0,
        observacao: item.observacao || '',
        usuario: req.user.username
      });
    }
  });

  saveMany(dados);
  res.json({ success: true, message: `Indicadores salvos para competencia ${competencia}` });
});

// Buscar indicadores por competencia
app.get('/api/aps/dados/:competencia', authMiddleware, (req, res) => {
  const indicadores = stmtsAPS.getIndicadores.all(req.params.competencia);
  res.json(indicadores);
});

// Buscar indicadores de uma unidade em uma competencia
app.get('/api/aps/dados/:competencia/:unidadeId', authMiddleware, (req, res) => {
  const indicadores = stmtsAPS.getIndicadoresByUnidade.all(req.params.unidadeId, req.params.competencia);
  res.json(indicadores);
});

// Lista competencias disponiveis
app.get('/api/aps/competencias', authMiddleware, (req, res) => {
  const competencias = stmtsAPS.getAllCompetencias.all();
  res.json(competencias.map(c => c.competencia));
});

// Resumo por indicador (para dashboard publico)
app.get('/api/aps/resumo/:competencia', (req, res) => {
  const resumo = stmtsAPS.getResumoIndicadores.all(req.params.competencia);
  const unidades = stmtsAPS.listUnidades.all();
  const indicadores = stmtsAPS.getIndicadores.all(req.params.competencia);
  res.json({ resumo, unidades, indicadores, definicoes: INDICADORES_APS });
});

// === VACINACAO ROUTES ===
const { stmtsVAC, IMUNOBIOLOGICOS } = require('./database');

app.get('/api/vac/imunobiologicos', authMiddleware, (req, res) => {
  res.json(IMUNOBIOLOGICOS);
});

app.get('/api/vac/dados/:ano', authMiddleware, (req, res) => {
  const dados = stmtsVAC.getByAno.all(parseInt(req.params.ano));
  res.json(dados);
});

app.post('/api/vac/dados', authMiddleware, (req, res) => {
  const { ano, dados } = req.body;
  if (!ano || !dados) return res.status(400).json({ error: 'Ano e dados obrigatorios' });

  const saveMany = db.transaction((items) => {
    for (const item of items) {
      const cobertura = item.denominador > 0 ? ((item.numerador / item.denominador) * 100) : 0;
      stmtsVAC.upsert.run({
        ano: parseInt(ano),
        imunobiologico: item.imunobiologico,
        numerador: item.numerador || 0,
        denominador: item.denominador || 0,
        cobertura: Math.round(cobertura * 100) / 100,
        meta: item.meta || 95,
        observacao: item.observacao || '',
        usuario: req.user.username
      });
    }
  });
  saveMany(dados);
  res.json({ success: true, message: `Cobertura vacinal ${ano} salva com sucesso` });
});

app.get('/api/vac/resumo/:ano', (req, res) => {
  const dados = stmtsVAC.getResumo.all(parseInt(req.params.ano));
  res.json({ ano: req.params.ano, dados, definicoes: IMUNOBIOLOGICOS });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve main dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Painel Vigilancia Araguari rodando em http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`Usuario: ${ADMIN_USER} / Senha: (env ADMIN_PASS ou padrao)`);
});

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

  const count = importarNotificacoes(records, category, originalName);

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

    // Se nao tem coordenadas, gerar baseado no bairro
    if (!lat || !lon) {
      const coords = geocodificarLocal(name);
      lat = coords.lat;
      lon = coords.lon;
    }

    const bairro = extrairBairroNome(name);
    points.push({ name, address: name, lat, lon, bairro });
  }

  const count = importarEdls(points, category, originalName);

  return {
    count,
    message: `KMZ (${category}): ${count} pontos importados`,
    stats: { points: count, withCoords: points.filter(p => p.lat).length }
  };
}

// Coordenadas conhecidas de bairros de Araguari
const BAIRRO_COORDS = {
  'aeroporto': [-18.6680, -48.1850], 'amorim': [-18.6350, -48.1950],
  'bosque': [-18.6360, -48.1730], 'brasilia': [-18.6520, -48.2050],
  'brasília': [-18.6520, -48.2050], 'centro': [-18.6470, -48.1900],
  'goias': [-18.6500, -48.1830], 'goiás': [-18.6500, -48.1830],
  'goiás parte alta': [-18.6510, -48.1800], 'independencia': [-18.6400, -48.1850],
  'independência': [-18.6400, -48.1850], 'industrial': [-18.6700, -48.1750],
  'distrito industrial': [-18.6720, -48.1780], 'maria eugenia': [-18.6580, -48.1820],
  'maria eugênia': [-18.6580, -48.1820], 'miranda': [-18.6530, -48.1780],
  'novo horizonte': [-18.6600, -48.2000], 'ouro verde': [-18.6620, -48.2080],
  'paraiso': [-18.6480, -48.1750], 'paraíso': [-18.6480, -48.1750],
  'santa helena': [-18.6380, -48.1780], 'santiago': [-18.6390, -48.2050],
  'sao sebastiao': [-18.6420, -48.1980], 'são sebastião': [-18.6420, -48.1980],
  'sibipiruna': [-18.6310, -48.1800], 'vieno': [-18.6570, -48.1700],
  'alan kardec': [-18.6410, -48.2080], 'joquei clube': [-18.6450, -48.1700],
  'jóquei clube': [-18.6450, -48.1700], 'fatima': [-18.6550, -48.1950],
  'fátima': [-18.6550, -48.1950], 'n.s fátima': [-18.6540, -48.1930],
  'são judas tadeu': [-18.6430, -48.2100], 'sao judas': [-18.6430, -48.2100],
  'park dos verdes': [-18.6380, -48.2120], 'bela suica': [-18.6300, -48.1880],
  'monte moria': [-18.6650, -48.1900], 'jardim milenium': [-18.6330, -48.2100],
  'sao joao': [-18.6440, -48.2030], 'portal dos ipes': [-18.6280, -48.1950],
  'gutierrez': [-18.6340, -48.2000],
};

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

function geocodificarLocal(name) {
  const lower = name.toLowerCase();
  
  // Tentar encontrar bairro no nome
  for (const [bairro, coords] of Object.entries(BAIRRO_COORDS)) {
    if (lower.includes(bairro)) {
      return {
        lat: coords[0] + (Math.random() - 0.5) * 0.003,
        lon: coords[1] + (Math.random() - 0.5) * 0.003
      };
    }
  }

  // Ruas conhecidas de Araguari (mapeamento manual)
  const STREET_MAP = {
    'batalhão mauá': [-18.658, -48.183], 'elias peixoto': [-18.649, -48.184],
    'circular': [-18.638, -48.178], 'coronel póvoa': [-18.647, -48.189],
    'florestina': [-18.653, -48.179], 'brasil': [-18.647, -48.191],
    'amazonas': [-18.645, -48.190], 'tiradentes': [-18.646, -48.190],
    'minas gerais': [-18.648, -48.188], 'joaquim barbosa': [-18.636, -48.194],
    'padre nicácio': [-18.635, -48.196], 'padre nicassio': [-18.635, -48.196],
    'saturno': [-18.660, -48.199], 'trindade': [-18.661, -48.200],
    'cristalina': [-18.653, -48.205], 'meia ponte': [-18.652, -48.203],
    'saudade': [-18.654, -48.178], 'piauí': [-18.648, -48.173],
    'sebastião naves': [-18.647, -48.175], 'hugo alessi': [-18.670, -48.174],
    'melo viana': [-18.649, -48.183], 'coromandel': [-18.646, -48.169],
    'br-050': [-18.671, -48.177], 'rodovia': [-18.671, -48.177],
    'floriano peixoto': [-18.648, -48.189], 'rio de janeiro': [-18.646, -48.187],
    'venezuela': [-18.651, -48.193], 'alvim borges': [-18.652, -48.182],
  };

  for (const [street, coords] of Object.entries(STREET_MAP)) {
    if (lower.includes(street)) {
      return {
        lat: coords[0] + (Math.random() - 0.5) * 0.002,
        lon: coords[1] + (Math.random() - 0.5) * 0.002
      };
    }
  }

  // Fallback: area urbana de Araguari
  return {
    lat: -18.648 + (Math.random() - 0.5) * 0.035,
    lon: -48.192 + (Math.random() - 0.5) * 0.035
  };
}

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

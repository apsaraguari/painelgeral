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

  // Simple XML parsing for placemarks
  const points = [];
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  const nameRegex = /<name>([\s\S]*?)<\/name>/;
  const addressRegex = /<address>([\s\S]*?)<\/address>/;
  const coordsRegex = /<coordinates>([\s\S]*?)<\/coordinates>/;

  let match;
  while ((match = placemarkRegex.exec(kmlContent)) !== null) {
    const content = match[1];
    const nameMatch = nameRegex.exec(content);
    const addrMatch = addressRegex.exec(content);
    const coordMatch = coordsRegex.exec(content);

    const name = nameMatch ? nameMatch[1].trim() : '';
    const address = addrMatch ? addrMatch[1].trim() : '';
    let lat = null, lon = null;
    if (coordMatch) {
      const parts = coordMatch[1].trim().split(',');
      if (parts.length >= 2) {
        lon = parseFloat(parts[0]);
        lat = parseFloat(parts[1]);
      }
    }

    points.push({ name, address, lat, lon, bairro: '' });
  }

  // Geocodificar pontos sem coordenadas
  const https = require('https');
  const streetCache = {};

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt.lat && pt.lon) continue;

    // Extrair nome da rua (sem numero)
    const street = pt.name.split(',')[0].trim();
    
    // Usar cache para mesma rua
    if (streetCache[street]) {
      const base = streetCache[street];
      // Pequeno offset para nao sobrepor
      pt.lat = base.lat + (Math.random() - 0.5) * 0.002;
      pt.lon = base.lon + (Math.random() - 0.5) * 0.002;
      continue;
    }

    // Geocodificar via Nominatim
    try {
      const coords = await geocodeAddress(street + ', Araguari, MG, Brazil', https);
      if (coords) {
        pt.lat = coords.lat;
        pt.lon = coords.lon;
        streetCache[street] = coords;
      } else {
        // Fallback: posicao central de Araguari com offset
        pt.lat = -18.648 + (Math.random() - 0.5) * 0.03;
        pt.lon = -48.195 + (Math.random() - 0.5) * 0.03;
      }
      // Rate limit: 1 req/sec para Nominatim
      await new Promise(r => setTimeout(r, 1100));
    } catch (e) {
      pt.lat = -18.648 + (Math.random() - 0.5) * 0.03;
      pt.lon = -48.195 + (Math.random() - 0.5) * 0.03;
    }
  }

  const count = importarEdls(points, category, originalName);

  return {
    count,
    message: `KMZ (${category}): ${count} pontos importados no banco`,
    stats: { points: count, withCoords: points.filter(p => p.lat).length }
  };
}

function geocodeAddress(query, https) {
  return new Promise((resolve, reject) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const options = { headers: { 'User-Agent': 'PainelVigilanciaAraguari/1.0' } };
    
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

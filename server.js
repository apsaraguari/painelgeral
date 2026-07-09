const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { DBFFile } = require('dbffile');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'araguari-vigilancia-2026-secret';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');

// Ensure directories exist
[UPLOAD_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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
  const originalName = req.file.originalname.toLowerCase();
  const category = req.body.category || 'geral';

  try {
    let result;
    if (originalName.endsWith('.dbf')) {
      result = await processDBF(filePath, category);
    } else if (originalName.endsWith('.kmz')) {
      result = await processKMZ(filePath, category);
    } else {
      return res.status(400).json({ error: 'Formato nao suportado. Use .dbf ou .kmz' });
    }

    // Regenerate dashboard data
    await regenerateDashboardData();

    res.json({ success: true, message: result.message, stats: result.stats });
  } catch (err) {
    console.error('Erro ao processar:', err);
    res.status(500).json({ error: `Erro ao processar arquivo: ${err.message}` });
  }
});

// Get current data status
app.get('/api/status', authMiddleware, (req, res) => {
  const dataFile = path.join(DATA_DIR, 'dashboard.json');
  let lastUpdate = null;
  let stats = {};

  if (fs.existsSync(dataFile)) {
    const stat = fs.statSync(dataFile);
    lastUpdate = stat.mtime;
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    stats = data.meta || {};
  }

  // List uploaded files
  const uploads = fs.existsSync(UPLOAD_DIR)
    ? fs.readdirSync(UPLOAD_DIR).map(f => {
        const s = fs.statSync(path.join(UPLOAD_DIR, f));
        return { name: f, size: s.size, date: s.mtime };
      }).sort((a, b) => b.date - a.date).slice(0, 20)
    : [];

  res.json({ lastUpdate, stats, uploads });
});

// Get dashboard data (public)
app.get('/api/data', (req, res) => {
  const dataFile = path.join(DATA_DIR, 'dashboard.json');
  if (fs.existsSync(dataFile)) {
    res.sendFile(dataFile);
  } else {
    res.status(404).json({ error: 'Dados nao encontrados. Faca upload dos arquivos.' });
  }
});

// Delete upload
app.delete('/api/upload/:filename', authMiddleware, (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Arquivo nao encontrado' });
  }
});

// === PROCESSING FUNCTIONS ===

async function processDBF(filePath, category) {
  const dbf = await DBFFile.open(filePath);
  const records = await dbf.readRecords(dbf.recordCount);

  const processed = { bairros: {}, monthly: {}, totals: { notif: 0, conf: 0, hosp: 0, obitos: 0 } };

  for (const rec of records) {
    const bairro = (rec.NM_BAIRRO || '').trim() || 'NAO INFORMADO';
    const dt = (rec.DT_SIN_PRI || '').toString().replace(/-/g, '');
    const classi = (rec.CLASSI_FIN || '').trim();
    const hosp = (rec.HOSPITALIZ || '').trim();
    const evol = (rec.EVOLUCAO || '').trim();

    let mes = '00';
    if (dt.length >= 6) {
      const year = dt.substring(0, 4);
      const month = dt.substring(4, 6);
      if (year === '2026' && ['01','02','03','04','05','06','07','08','09','10','11','12'].includes(month)) {
        mes = month;
      }
    }

    if (!processed.bairros[bairro]) {
      processed.bairros[bairro] = { notif: 0, conf: 0, months: {} };
    }
    processed.bairros[bairro].notif++;
    processed.totals.notif++;

    // Confirmed cases
    const isConfirmed = (category === 'dengue' && classi === '10') ||
                        (category === 'chikungunya' && classi === '13');
    if (isConfirmed) {
      processed.bairros[bairro].conf++;
      processed.totals.conf++;
    }

    if (hosp === '1') processed.totals.hosp++;
    if (evol === '2') processed.totals.obitos++;

    // Monthly
    if (mes !== '00') {
      if (!processed.bairros[bairro].months[mes]) {
        processed.bairros[bairro].months[mes] = { notif: 0, conf: 0 };
      }
      processed.bairros[bairro].months[mes].notif++;
      if (isConfirmed) processed.bairros[bairro].months[mes].conf++;

      if (!processed.monthly[mes]) processed.monthly[mes] = { notif: 0, conf: 0 };
      processed.monthly[mes].notif++;
      if (isConfirmed) processed.monthly[mes].conf++;
    }
  }

  // Save processed data
  const outputFile = path.join(DATA_DIR, `${category}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(processed, null, 2));

  return {
    message: `${category}: ${records.length} registros processados`,
    stats: { records: records.length, bairros: Object.keys(processed.bairros).length, confirmed: processed.totals.conf }
  };
}

async function processKMZ(filePath, category) {
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

    points.push({ name, address, lat, lon, category });
  }

  const outputFile = path.join(DATA_DIR, `edl_${category}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(points, null, 2));

  return {
    message: `KMZ (${category}): ${points.length} pontos extraidos`,
    stats: { points: points.length, withCoords: points.filter(p => p.lat).length }
  };
}

async function regenerateDashboardData() {
  const dashboard = { meta: {}, bairros: {}, edls: [], curve: {}, updated: new Date().toISOString() };

  // Load dengue data
  const dengueFile = path.join(DATA_DIR, 'dengue.json');
  if (fs.existsSync(dengueFile)) {
    const dengue = JSON.parse(fs.readFileSync(dengueFile, 'utf-8'));
    dashboard.meta.dengue = dengue.totals;
    for (const [bairro, data] of Object.entries(dengue.bairros)) {
      if (!dashboard.bairros[bairro]) dashboard.bairros[bairro] = { d_n: 0, d_c: 0, c_n: 0, c_c: 0, months: {} };
      dashboard.bairros[bairro].d_n = data.notif;
      dashboard.bairros[bairro].d_c = data.conf;
      for (const [m, mdata] of Object.entries(data.months || {})) {
        if (!dashboard.bairros[bairro].months[m]) dashboard.bairros[bairro].months[m] = { d_n: 0, d_c: 0, c_n: 0, c_c: 0 };
        dashboard.bairros[bairro].months[m].d_n = mdata.notif;
        dashboard.bairros[bairro].months[m].d_c = mdata.conf;
      }
    }
    dashboard.curve.dengue = dengue.monthly;
  }

  // Load chikungunya data
  const chikFile = path.join(DATA_DIR, 'chikungunya.json');
  if (fs.existsSync(chikFile)) {
    const chik = JSON.parse(fs.readFileSync(chikFile, 'utf-8'));
    dashboard.meta.chikungunya = chik.totals;
    for (const [bairro, data] of Object.entries(chik.bairros)) {
      if (!dashboard.bairros[bairro]) dashboard.bairros[bairro] = { d_n: 0, d_c: 0, c_n: 0, c_c: 0, months: {} };
      dashboard.bairros[bairro].c_n = data.notif;
      dashboard.bairros[bairro].c_c = data.conf;
      for (const [m, mdata] of Object.entries(data.months || {})) {
        if (!dashboard.bairros[bairro].months[m]) dashboard.bairros[bairro].months[m] = { d_n: 0, d_c: 0, c_n: 0, c_c: 0 };
        dashboard.bairros[bairro].months[m].c_n = mdata.notif;
        dashboard.bairros[bairro].months[m].c_c = mdata.conf;
      }
    }
    dashboard.curve.chikungunya = chik.monthly;
  }

  // Load EDL data
  const edlFiles = ['edl_pe.json', 'edl_residencial.json'];
  for (const ef of edlFiles) {
    const edlFile = path.join(DATA_DIR, ef);
    if (fs.existsSync(edlFile)) {
      const edls = JSON.parse(fs.readFileSync(edlFile, 'utf-8'));
      dashboard.edls.push(...edls);
    }
  }

  // Save dashboard.json
  const outputFile = path.join(DATA_DIR, 'dashboard.json');
  fs.writeFileSync(outputFile, JSON.stringify(dashboard));

  console.log(`Dashboard atualizado: ${Object.keys(dashboard.bairros).length} bairros, ${dashboard.edls.length} EDLs`);
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

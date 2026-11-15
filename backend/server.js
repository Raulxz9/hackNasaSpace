const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

let dotenvError = null;
try {
    require('dotenv').config();
} catch (err) {
    dotenvError = err;
}

const express = require('express');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const csv = require('csv-parser');
const axios = require('axios');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------------------------------------------
// ARCHIVO DE LOGS Y LOGGER CENTRALIZADO
// ---------------------------------------------------------------
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB por archivo antes de rotar a .old
let logFilePath = null;
let logStream = null;
let logInitWarning = null;

function inicializarArchivoLog() {
    const candidatos = [];
    if (process.env.LOG_FILE_PATH && process.env.LOG_FILE_PATH.trim()) {
        const rawLog = process.env.LOG_FILE_PATH.trim();
        candidatos.push(path.isAbsolute(rawLog) ? rawLog : path.resolve(__dirname, rawLog));
    }
    candidatos.push(path.join(__dirname, 'logs', 'iris-backend.log'));
    candidatos.push(path.join(os.tmpdir(), 'iris-backend.log'));

    for (const ruta of candidatos) {
        try {
            fs.mkdirSync(path.dirname(ruta), { recursive: true });
            if (fs.existsSync(ruta)) {
                const stats = fs.statSync(ruta);
                if (stats.size > MAX_LOG_BYTES) {
                    const backupPath = `${ruta}.old`;
                    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
                    fs.renameSync(ruta, backupPath);
                }
            }
            const stream = fs.createWriteStream(ruta, { flags: 'a', encoding: 'utf8' });
            stream.on('error', (err) => {
                try {
                    console.error(`[${new Date().toISOString()}] [WARN] Error al escribir en archivo de log:`, err.message);
                } catch {
                    // ignore console failure
                }
                logStream = null;
            });
            logFilePath = ruta;
            logStream = stream;
            return;
        } catch (err) {
            logInitWarning = `No se pudo inicializar log en ${ruta}: ${err.message}`;
        }
    }
}

inicializarArchivoLog();

const formatearExtra = (extra) => {
    if (extra === undefined || extra === null || extra === '') return '';
    if (typeof extra === 'string') return extra;
    if (extra instanceof Error) return extra.stack || extra.message;
    try {
        return JSON.stringify(extra);
    } catch {
        return String(extra);
    }
};

const escribirArchivoLog = (linea, sync = false) => {
    if (!logFilePath) return;
    try {
        if (sync || !logStream || logStream.destroyed) {
            fs.appendFileSync(logFilePath, `${linea}\n`, 'utf8');
        } else {
            logStream.write(`${linea}\n`);
        }
    } catch {
        // Evita que un fallo de E/S en el log interrumpa la API
    }
};

const log = (nivel, msg, extra = '', opciones = {}) => {
    const extraTxt = formatearExtra(extra);
    const linea = `[${new Date().toISOString()}] [${nivel}] ${msg}${extraTxt ? ` ${extraTxt}` : ''}`;
    try {
        if (nivel === 'ERROR') {
            console.error(linea);
        } else if (nivel === 'WARN') {
            console.warn(linea);
        } else {
            console.log(linea);
        }
    } catch {
        // ignore console errors
    }
    escribirArchivoLog(linea, Boolean(opciones.sync));
};

const logError = (contexto, error, opciones = {}) => {
    try {
        const msg = error && error.message ? error.message : String(error);
        log('ERROR', `${contexto}: ${msg}`, '', opciones);
        if (error && error.response) {
            log('ERROR', `HTTP ${error.response.status}`, String(error.response.data || '').slice(0, 500), opciones);
        }
        if (error && error.code) log('ERROR', `Código: ${error.code}`, '', opciones);
        if (error && error.stack) log('ERROR', 'Stack:', error.stack, opciones);
    } catch (innerErr) {
        try {
            console.error('[ERROR] Fallo en logError:', innerErr.message);
        } catch {
            // ignore
        }
    }
};

// Habilita CORS para que el frontend pueda hacer peticiones desde cualquier origen
app.use(cors());
app.use(express.json());

// Configuración de Google Cloud Storage (soporta JSON inline en nube y ruta de archivo JSON en local)
let storage = null;
let gcpConfigError = null;
const hasGcpEnv = Boolean(
    (process.env.GCP_CREDENTIALS_JSON && process.env.GCP_CREDENTIALS_JSON.trim()) ||
    (process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_APPLICATION_CREDENTIALS.trim())
);

try {
    if (process.env.GCP_CREDENTIALS_JSON && process.env.GCP_CREDENTIALS_JSON.trim()) {
        const rawCred = process.env.GCP_CREDENTIALS_JSON.trim().replace(/^['"]|['"]$/g, '');
        if (rawCred.startsWith('{')) {
            const credentials = JSON.parse(rawCred);
            storage = new Storage({
                projectId: credentials.project_id,
                credentials
            });
        } else {
            const resolvedPath = path.isAbsolute(rawCred) ? rawCred : path.resolve(__dirname, rawCred);
            if (fs.existsSync(resolvedPath)) {
                const credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
                storage = new Storage({
                    projectId: credentials.project_id,
                    credentials
                });
            } else {
                gcpConfigError = `No se encontró el archivo de credenciales GCP en: ${resolvedPath}`;
            }
        }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_APPLICATION_CREDENTIALS.trim()) {
        const rawPath = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().replace(/^['"]|['"]$/g, '');
        const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);
        if (fs.existsSync(resolvedPath)) {
            storage = new Storage({ keyFilename: resolvedPath });
        } else {
            gcpConfigError = `No se encontró el archivo GOOGLE_APPLICATION_CREDENTIALS en: ${resolvedPath}`;
        }
    }
} catch (err) {
    gcpConfigError = `Error al configurar credenciales GCP: ${err.message}`;
    logError('Inicialización GCS', err);
}

if (!storage) {
    try {
        storage = new Storage();
    } catch (err) {
        gcpConfigError = gcpConfigError || `No se pudo inicializar Google Cloud Storage: ${err.message}`;
        logError('Fallback Storage()', err);
    }
}

const BUCKET_NAME = (process.env.BUCKET_NAME || 'incendios-datos-bucket-2026').trim();
const NASA_MAP_KEY = (process.env.NASA_MAP_KEY || '').trim();
const FUENTE_NASA = 'VIIRS_NOAA20_NRT';
const LIMITE_POR_DEFECTO = 100000; // máximo de registros devueltos por consulta
const CONCURRENCIA_GCS = 32;       // archivos leídos en paralelo en consultas GCS
const CONCURRENCIA_GCS_INDEX = 20; // streaming paralelo al indexar un mes completo
const CONCURRENCIA_GCS_MEDIANA = 24;
const CONCURRENCIA_GCS_SYNC = 16;  // escritura paralela de CSVs por país en GCS
const RADIO_TIERRA_KM = 6371;
const ANIO_MINIMO_GCS = 2000;
const TTL_MUNDO_HOY_MS = 5 * 60 * 1000;
const GCS_CACHE_PREFIX = '_iris_cache';
const CACHE_SCHEMA_VERSION = 2;
const TMP_CACHE_DIR = path.join(os.tmpdir(), 'iris-cache-v1');
const MAX_TMP_CACHE_BYTES = process.env.VERCEL === '1' ? 160 * 1024 * 1024 : 400 * 1024 * 1024;
const MAX_MEM_COMPRESSED_BYTES = process.env.VERCEL === '1' ? 24 * 1024 * 1024 : 48 * 1024 * 1024;

app.use((req, res, next) => {
    const inicio = Date.now();
    try {
        log('REQ', `${req.method} ${req.originalUrl}`);
        res.on('finish', () => {
            try {
                log('RES', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio} ms)`);
            } catch {
                // ignore logging error
            }
        });
    } catch {
        // ignore logging error
    }
    next();
});

if (dotenvError) {
    logError('dotenv.config', dotenvError);
}
if (logFilePath) {
    log('INFO', `Archivo de log activo: ${logFilePath}`);
} else if (logInitWarning) {
    log('WARN', logInitWarning);
}
if (gcpConfigError) {
    log('WARN', gcpConfigError);
} else if (!hasGcpEnv) {
    log('WARN', 'Faltan GCP_CREDENTIALS_JSON / GOOGLE_APPLICATION_CREDENTIALS en backend/.env. Crea backend/.env (puedes copiar backend/.env.example) para leer datos históricos de GCS.');
}
if (!NASA_MAP_KEY) {
    log('WARN', 'Falta NASA_MAP_KEY en el .env. Solo funcionarán las consultas históricas desde GCS.');
}
log('INFO', `Bucket configurado: "${BUCKET_NAME}"`);

// ---------------------------------------------------------------
// UTILIDADES Y CLASIFICACIÓN
// ---------------------------------------------------------------
const obtenerFechaHoy = () => new Date().toISOString().slice(0, 10); // UTC, igual que acq_date

const obtenerFechaAyer = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

const normalizar = (s) => String(s || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');

// Esquema de los archivos armonizados en GCS (ej. 2000_11_Afghanistan.csv)
const ESQUEMA = ['latitude', 'longitude', 'scan', 'confidence', 'daynight',
    'datetime', 'frp', 'sensor', 'frp_log', 'scan_norm', 'frp_log_norm'];
const ESQUEMA_CSV = [...ESQUEMA, 'country'];
const HEADER_ESTANDAR_ESQUEMA = ESQUEMA.join(',');
const HEADER_ESTANDAR_CSV = ESQUEMA_CSV.join(',');
const COMPACT_COLS = ['latitude', 'longitude', 'scan', 'confidence', 'daynight',
    'datetime', 'frp', 'sensor', 'frp_log_norm', 'country'];
const COMPACT_IDX_CANON = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11]; // índices dentro de ESQUEMA_CSV

const aceptaGzip = (req) => /\bgzip\b/i.test(String((req && req.headers && req.headers['accept-encoding']) || ''));

async function enviarJson(req, res, payload, status = 200) {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    res.status(status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    if (aceptaGzip(req) && raw.length >= 1024) {
        try {
            const gz = await gzipAsync(raw, { level: 1 });
            res.setHeader('Content-Encoding', 'gzip');
            return res.send(gz);
        } catch {
            // fallback sin compresión
        }
    }
    return res.send(raw);
}

async function enviarBufferJsonGzip(req, res, gzBuf, status = 200) {
    res.status(status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    if (aceptaGzip(req)) {
        res.setHeader('Content-Encoding', 'gzip');
        return res.send(gzBuf);
    }
    const raw = await gunzipAsync(gzBuf);
    return res.send(raw);
}

async function enviarCsv(req, res, csvTexto, nombreCsv) {
    const raw = Buffer.from(csvTexto, 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreCsv}"`);
    res.setHeader('Vary', 'Accept-Encoding');
    if (aceptaGzip(req) && raw.length >= 1024) {
        try {
            const gz = await gzipAsync(raw, { level: 1 });
            res.setHeader('Content-Encoding', 'gzip');
            return res.send(gz);
        } catch {
            // fallback sin compresión
        }
    }
    return res.send(raw);
}

const aCompactoFilas = (registros) =>
    (registros || []).map((r) => [
        r.latitude ?? '',
        r.longitude ?? '',
        r.scan ?? '',
        r.confidence ?? '',
        r.daynight ?? '',
        r.datetime ?? '',
        r.frp ?? '',
        r.sensor ?? '',
        r.frp_log_norm ?? '',
        r.country ?? ''
    ]);

const NIVELES_INTENSIDAD = ['Sin datos', 'Bajo', 'Moderado', 'Alto', 'Crítico', 'Extremo'];

const clasificarNivelFrp = (frpRaw) => {
    const frp = parseFloat(frpRaw);
    if (!Number.isFinite(frp) || frp < 15) return 1;
    if (frp < 50) return 2;
    if (frp < 150) return 3;
    if (frp < 400) return 4;
    return 5;
};

const nombreIntensidad = (nivel) => NIVELES_INTENSIDAD[nivel] || 'Sin datos';

const diasEnMes = (anio, mesNum) => new Date(Date.UTC(anio, mesNum, 0)).getUTCDate();

const fechaDe = (r) => String(r.datetime || r.acq_date || '').slice(0, 10);
const horaDe = (r) => {
    if (r.datetime) return String(r.datetime).slice(11, 16).replace(':', '');
    return String(r.acq_time || '').replace(':', '').padStart(4, '0');
};

const claveRegistro = (r) => `${r.latitude}-${r.longitude}-${fechaDe(r)}-${horaDe(r)}`;

// Convierte una fila de NASA FIRMS al esquema armonizado
const nasaAEsquema = (r) => {
    try {
        const hhmm = String((r && r.acq_time) || '').padStart(4, '0');
        const frp = parseFloat(r && r.frp);
        const mapped = {
            latitude: r.latitude,
            longitude: r.longitude,
            scan: r.scan,
            confidence: r.confidence,
            daynight: r.daynight,
            datetime: `${r.acq_date || ''} ${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`.trim(),
            frp: r.frp,
            sensor: 'VIIRS',
            frp_log: Number.isFinite(frp) ? Math.log1p(Math.max(0, frp)) : '',
            scan_norm: '',
            frp_log_norm: '',
            country: r.country || r.country_id || ''
        };
        return mapped;
    } catch (error) {
        logError('nasaAEsquema', error);
        return null;
    }
};

const escaparCsv = (valor) => {
    const s = valor === undefined || valor === null ? '' : String(valor);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const generarCsv = (registros, columnas = ESQUEMA) => {
    try {
        const filas = (registros || []).map(r => columnas.map(c => escaparCsv(r && r[c])).join(','));
        return [columnas.join(','), ...filas].join('\n');
    } catch (error) {
        logError('generarCsv', error);
        throw error;
    }
};

const parsearCsvTexto = (texto) => new Promise((resolve, reject) => {
    const filas = [];
    try {
        Readable.from([String(texto || '')])
            .pipe(csv())
            .on('data', (row) => {
                try {
                    filas.push(row);
                } catch (err) {
                    reject(err);
                }
            })
            .on('end', () => resolve(filas))
            .on('error', reject);
    } catch (error) {
        reject(error);
    }
});

function escanearLineasStream(stream, onLine) {
    return new Promise((resolve, reject) => {
        let carry = null;
        stream.on('error', reject);
        stream.on('data', (chunk) => {
            try {
                const data = carry && carry.length ? Buffer.concat([carry, chunk]) : chunk;
                carry = null;
                const len = data.length;
                let pos = 0;
                while (pos < len) {
                    const nl = data.indexOf(0x0a, pos);
                    if (nl === -1) {
                        carry = Buffer.from(data.subarray(pos));
                        break;
                    }
                    let lineEnd = nl;
                    if (lineEnd > pos && data[lineEnd - 1] === 0x0d) lineEnd--;
                    if (lineEnd > pos) onLine(data, pos, lineEnd);
                    pos = nl + 1;
                }
            } catch (err) {
                stream.destroy(err);
                reject(err);
            }
        });
        stream.on('end', () => {
            try {
                if (carry && carry.length > 0) {
                    let lineEnd = carry.length;
                    if (lineEnd > 0 && carry[lineEnd - 1] === 0x0d) lineEnd--;
                    if (lineEnd > 0) onLine(carry, 0, lineEnd);
                }
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
}

const leerCsvGcs = (file, onRow) => {
    let cols = null;
    return escanearLineasStream(file.createReadStream(), (buf, start, end) => {
        const line = buf.toString('utf8', start, end);
        const tieneComillas = line.indexOf('"') !== -1;
        const vals = tieneComillas ? parseCsvLineQuoted(line) : line.split(',');
        if (!cols) {
            cols = vals.map((c) => c.trim());
            return;
        }
        const row = {};
        for (let i = 0; i < cols.length; i++) {
            row[cols[i]] = vals[i] !== undefined ? vals[i] : '';
        }
        onRow(row);
    });
};

function parseCsvLineQuoted(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

// Lector streaming sin asignar objetos ni strings de línea completa (solo fecha y frp)
function escanearCsvResumenGcs(file, onCampos) {
    let headerParsed = false;
    let iDate = -1;
    let iFrp = -1;
    let maxColIdx = -1;

    return escanearLineasStream(file.createReadStream(), (buf, start, end) => {
        if (!headerParsed) {
            headerParsed = true;
            const line = buf.toString('utf8', start, end);
            const cols = (line.indexOf('"') !== -1 ? parseCsvLineQuoted(line) : line.split(','))
                .map(c => c.trim().toLowerCase());
            iDate = cols.indexOf('datetime');
            if (iDate === -1) iDate = cols.indexOf('acq_date');
            iFrp = cols.indexOf('frp');
            maxColIdx = Math.max(iDate, iFrp);
            return;
        }
        if (maxColIdx < 0) return;

        // Respaldo seguro solo si la línea contiene comillas
        if (buf.subarray(start, end).indexOf(0x22) !== -1) {
            const cols = parseCsvLineQuoted(buf.toString('utf8', start, end));
            onCampos(iDate >= 0 ? cols[iDate] : '', iFrp >= 0 ? cols[iFrp] : '');
            return;
        }

        let curCol = 0;
        let colStart = start;
        let dateStr = '';
        let frpStr = '';
        for (let k = start; k <= end; k++) {
            if (k === end || buf[k] === 0x2c) {
                if (curCol === iDate) {
                    dateStr = buf.toString('ascii', colStart, Math.min(k, colStart + 10));
                } else if (curCol === iFrp) {
                    frpStr = buf.toString('ascii', colStart, k);
                }
                if (curCol >= maxColIdx) break;
                curCol++;
                colStart = k + 1;
            }
        }
        onCampos(dateStr, frpStr);
    });
}

function puntoEnBbox(lat, lon, bbox) {
    if (!bbox) return true;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (lat < bbox.south || lat > bbox.north) return false;
    if (bbox.west <= bbox.east) {
        return lon >= bbox.west && lon <= bbox.east;
    }
    // Cruza antimeridiano ±180°
    return lon >= bbox.west || lon <= bbox.east;
}

// Lector streaming con filtrado bbox opcional (sin asignar objetos por fila)
function escanearCsvResumenConCoordsGcs(file, bbox, onCampos) {
    if (!bbox) return escanearCsvResumenGcs(file, onCampos);

    let headerParsed = false;
    let iDate = -1;
    let iFrp = -1;
    let iLat = -1;
    let iLon = -1;
    let maxColIdx = -1;

    return escanearLineasStream(file.createReadStream(), (buf, start, end) => {
        if (!headerParsed) {
            headerParsed = true;
            const line = buf.toString('utf8', start, end);
            const cols = (line.indexOf('"') !== -1 ? parseCsvLineQuoted(line) : line.split(','))
                .map(c => c.trim().toLowerCase());
            iDate = cols.indexOf('datetime');
            if (iDate === -1) iDate = cols.indexOf('acq_date');
            iFrp = cols.indexOf('frp');
            iLat = cols.indexOf('latitude');
            iLon = cols.indexOf('longitude');
            maxColIdx = Math.max(iDate, iFrp, iLat, iLon);
            return;
        }
        if (maxColIdx < 0 || iLat < 0 || iLon < 0) return;

        if (buf.subarray(start, end).indexOf(0x22) !== -1) {
            const cols = parseCsvLineQuoted(buf.toString('utf8', start, end));
            const lat = parseFloat(cols[iLat]);
            const lon = parseFloat(cols[iLon]);
            if (!puntoEnBbox(lat, lon, bbox)) return;
            onCampos(iDate >= 0 ? cols[iDate] : '', iFrp >= 0 ? cols[iFrp] : '');
            return;
        }

        let curCol = 0;
        let colStart = start;
        let dateStr = '';
        let frpStr = '';
        let latStr = '';
        let lonStr = '';
        for (let k = start; k <= end; k++) {
            if (k === end || buf[k] === 0x2c) {
                if (curCol === iLat) {
                    latStr = buf.toString('ascii', colStart, k);
                } else if (curCol === iLon) {
                    lonStr = buf.toString('ascii', colStart, k);
                } else if (curCol === iDate) {
                    dateStr = buf.toString('ascii', colStart, Math.min(k, colStart + 10));
                } else if (curCol === iFrp) {
                    frpStr = buf.toString('ascii', colStart, k);
                }
                if (curCol >= maxColIdx) break;
                curCol++;
                colStart = k + 1;
            }
        }
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);
        if (!puntoEnBbox(lat, lon, bbox)) return;
        onCampos(dateStr, frpStr);
    });
}

// Conteo rápido de filas usando Buffer.indexOf(0x0a) nativo en C++/SIMD
function contarFilasCsvGcs(file) {
    return new Promise((resolve, reject) => {
        try {
            let lines = 0;
            let lineHasContent = false;
            const stream = file.createReadStream();
            stream.on('error', reject);
            stream.on('data', (chunk) => {
                try {
                    let pos = 0;
                    const len = chunk.length;
                    while (pos < len) {
                        const nl = chunk.indexOf(0x0a, pos);
                        if (nl === -1) {
                            for (let k = pos; k < len; k++) {
                                const b = chunk[k];
                                if (b !== 0x0d && b !== 0x20 && b !== 0x09) {
                                    lineHasContent = true;
                                    break;
                                }
                            }
                            break;
                        }
                        if (lineHasContent) {
                            lines++;
                            lineHasContent = false;
                        } else {
                            for (let k = pos; k < nl; k++) {
                                const b = chunk[k];
                                if (b !== 0x0d && b !== 0x20 && b !== 0x09) {
                                    lines++;
                                    break;
                                }
                            }
                        }
                        pos = nl + 1;
                    }
                } catch (err) {
                    stream.destroy(err);
                    reject(err);
                }
            });
            stream.on('end', () => {
                try {
                    if (lineHasContent) lines++;
                    resolve(Math.max(0, lines - 1));
                } catch (err) {
                    reject(err);
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

const ordenarPorTamanoDesc = (archivos) =>
    (archivos || []).slice().sort((a, b) => (Number((b.file && b.file.metadata && b.file.metadata.size) || 0) - Number((a.file && a.file.metadata && a.file.metadata.size) || 0)));

async function conLimite(items, limite, fn) {
    try {
        let i = 0;
        const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
            while (i < items.length) {
                const item = items[i++];
                try {
                    await fn(item);
                } catch (e) {
                    logError(`procesando ${item && item.nombre ? item.nombre : item}`, e);
                }
            }
        });
        await Promise.all(trabajadores);
    } catch (error) {
        logError('conLimite', error);
        throw error;
    }
}

const distanciaKm = (lat1, lon1, lat2, lon2) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * RADIO_TIERRA_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const parsearFiltrosEspaciales = (query) => {
    const tieneBbox = ['north', 'south', 'east', 'west'].some(k => query[k] !== undefined && query[k] !== '');
    const tieneRadio = ['lat', 'lon', 'radioKm'].some(k => query[k] !== undefined && query[k] !== '');

    let bbox = null;
    if (tieneBbox) {
        const north = parseFloat(query.north);
        const south = parseFloat(query.south);
        const east = parseFloat(query.east);
        const west = parseFloat(query.west);
        if (![north, south, east, west].every(Number.isFinite) || south > north) {
            return { error: 'Parámetros bbox inválidos. Debes enviar north, south, east y west numéricos (south <= north).' };
        }
        bbox = { north, south, east, west };
    }

    let radio = null;
    if (tieneRadio) {
        const lat = parseFloat(query.lat);
        const lon = parseFloat(query.lon);
        const radioKm = parseFloat(query.radioKm);
        if (![lat, lon, radioKm].every(Number.isFinite) || radioKm <= 0) {
            return { error: 'Parámetros espaciales inválidos. Debes enviar lat, lon y radioKm > 0.' };
        }
        radio = { lat, lon, radioKm };
    }

    return { bbox, radio };
};

const construirPredicado = ({ fecha, horaInicio, horaFin, bbox, radio }) => {
    const hInicio = horaInicio ? horaInicio.replace(':', '').padStart(4, '0') : null;
    const hFin = horaFin ? horaFin.replace(':', '').padStart(4, '0') : null;
    return (row) => {
        if (fecha && fechaDe(row) !== fecha) return false;
        if (hInicio && hFin) {
            const h = horaDe(row);
            if (h < hInicio || h > hFin) return false;
        }
        if (bbox || radio) {
            const rLat = parseFloat(row.latitude);
            const rLon = parseFloat(row.longitude);
            if (!Number.isFinite(rLat) || !Number.isFinite(rLon)) return false;
            if (bbox) {
                if (rLat < bbox.south || rLat > bbox.north) return false;
                if (bbox.west <= bbox.east) {
                    if (rLon < bbox.west || rLon > bbox.east) return false;
                } else {
                    // Cruza antimeridiano ±180°
                    if (rLon < bbox.west && rLon > bbox.east) return false;
                }
            }
            if (radio) {
                if (distanciaKm(radio.lat, radio.lon, rLat, rLon) > radio.radioKm) return false;
            }
        }
        return true;
    };
};

const crearColector = (predicado, limite) => {
    const data = [];
    let total = 0;
    return {
        data,
        get total() { return total; },
        add(row) {
            if (!predicado(row)) return;
            total++;
            if (data.length < limite) data.push(row);
        }
    };
};

// ---------------------------------------------------------------
// GCS: archivos del mes / año
// ---------------------------------------------------------------
const archivosAnioCache = new Map();

async function listarArchivosMes(anio, mes) {
    try {
        if (gcpConfigError) throw new Error(gcpConfigError);
        const prefijo = `${anio}_${mes}_`;
        const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: prefijo });
        const archivos = files
            .filter(f => f.name.toLowerCase().endsWith('.csv'))
            .map(f => ({
                file: f,
                nombre: f.name,
                pais: f.name.slice(prefijo.length, -4).replace(/_/g, ' ')
            }))
            .filter(a => normalizar(a.pais) !== 'world');
        log('INFO', `GCS: ${archivos.length} archivos de país con prefijo "${prefijo}"`);
        return archivos;
    } catch (error) {
        logError(`listarArchivosMes(${anio}-${mes})`, error);
        throw error;
    }
}

async function listarArchivosAnioPorMes(anio) {
    try {
        if (gcpConfigError) throw new Error(gcpConfigError);
        const anioNum = parseInt(anio, 10);
        const hoyAnio = new Date().getUTCFullYear();
        const ttl = anioNum < hoyAnio ? 6 * 60 * 60 * 1000 : 2 * 60 * 1000;
        const cached = archivosAnioCache.get(String(anio));
        if (cached && Date.now() - cached.ts < ttl) {
            return cached.porMes;
        }
        const prefijo = `${anio}_`;
        const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: prefijo });
        const porMes = Array.from({ length: 12 }, () => []);
        for (const f of files) {
            if (!f.name.toLowerCase().endsWith('.csv')) continue;
            const m = f.name.match(/^(\d{4})_(\d{2})_(.+)\.csv$/i);
            if (!m) continue;
            const mesIdx = parseInt(m[2], 10) - 1;
            if (mesIdx < 0 || mesIdx > 11) continue;
            const pais = m[3].replace(/_/g, ' ');
            if (normalizar(pais) === 'world') continue;
            porMes[mesIdx].push({ file: f, nombre: f.name, pais });
        }
        archivosAnioCache.set(String(anio), { ts: Date.now(), porMes });
        return porMes;
    } catch (error) {
        logError(`listarArchivosAnioPorMes(${anio})`, error);
        throw error;
    }
}

// ---------------------------------------------------------------
// NASA FIRMS
// ---------------------------------------------------------------
const ocultarKey = (url) => (NASA_MAP_KEY ? url.replace(NASA_MAP_KEY, '***') : url);

async function pedirCsvNasa(url) {
    try {
        log('INFO', `Consultando NASA: ${ocultarKey(url)}`);
        const response = await axios.get(url, { timeout: 120000, responseType: 'text' });
        const texto = response.data;
        log('INFO', `NASA respondió HTTP ${response.status}, ${String(texto).length} caracteres`);

        if (typeof texto !== 'string' || !texto.startsWith('latitude')) {
            log('ERROR', 'Respuesta inesperada de la NASA:', String(texto).slice(0, 300));
            return null;
        }
        return await parsearCsvTexto(texto);
    } catch (error) {
        logError(`pedirCsvNasa(${ocultarKey(url)})`, error);
        return null;
    }
}

// ---------------------------------------------------------------
// GEOCODIFICACIÓN OFFLINE POR PAÍS Y SINCRONIZACIÓN NASA -> GCS
// ---------------------------------------------------------------
const ISO3_A_GCS_SLUG = {
    BHS: 'Bahamas',
    BRN: 'Brunei_Darussalam',
    CHN: 'China',
    CIV: 'Cote_d_Ivoire',
    COG: 'Republic_of_Congo',
    CUW: 'Curacao',
    CYP: 'Cyprus',
    CZE: 'Czech_Republic',
    GUF: 'French_Guiana',
    HKG: 'Hong_Kong',
    HMD: 'Heard_I_and_McDonald_Islands',
    IRL: 'Ireland',
    KOR: 'Republic_of_Korea',
    LAO: 'Lao_PDR',
    MKD: 'Macedonia_Former_Yugoslav_Republic_of',
    MTQ: 'Martinique',
    MYT: 'Mayotte',
    NCL: 'New_Caledonia',
    PRI: 'Puerto_Rico',
    PRK: 'Dem_Rep_Korea',
    PYF: 'French_Polynesia',
    RUS: 'Russian_Federation',
    SWZ: 'Swaziland',
    TLS: 'Timor-Leste',
    USA: 'United_States',
    VCT: 'Saint_Vincent_and_the_Grenadines'
};

const ALIAS_PAISES_EXTRA = {
    'estados unidos': 'USA',
    'united states of america': 'USA',
    'eeuu': 'USA',
    'usa': 'USA',
    'mexico': 'MEX',
    'méxico': 'MEX',
    'rusia': 'RUS',
    'russia': 'RUS',
    'russian federation': 'RUS',
    'reino unido': 'GBR',
    'united kingdom': 'GBR',
    'turquia': 'TUR',
    'turquía': 'TUR',
    'türkiye': 'TUR',
    'brasil': 'BRA',
    'brazil': 'BRA',
    'espana': 'ESP',
    'españa': 'ESP',
    'francia': 'FRA',
    'alemania': 'DEU',
    'italia': 'ITA',
    'canada': 'CAN',
    'canadá': 'CAN',
    'corea del sur': 'KOR',
    'south korea': 'KOR',
    'corea del norte': 'PRK',
    'north korea': 'PRK',
    'costa de marfil': 'CIV',
    "cote d'ivoire": 'CIV',
    'suazilandia': 'SWZ',
    'eswatini': 'SWZ',
    'chequia': 'CZE',
    'czechia': 'CZE',
    'vietnam': 'VNM',
    'viet nam': 'VNM'
};

const sanitizarSlugPais = (nombre) =>
    String(nombre || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['’.,()]/g, ' ')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');

let geocoderPromise = null;
async function obtenerGeocoderPaises() {
    if (!geocoderPromise) {
        geocoderPromise = import('@rapideditor/country-coder').catch((err) => {
            geocoderPromise = null;
            logError('obtenerGeocoderPaises', err);
            return null;
        });
    }
    return geocoderPromise;
}

function clasificarPaisPorCoordenada(countryCoder, latRaw, lonRaw) {
    if (!countryCoder) return null;
    const lat = parseFloat(latRaw);
    const lon = parseFloat(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const pt = [normLon, lat];

    const territoryFeat = countryCoder.feature(pt, { maxLevel: 'territory' });
    let iso3 = territoryFeat && territoryFeat.properties && territoryFeat.properties.iso1A3
        ? territoryFeat.properties.iso1A3
        : null;
    let nameEn = territoryFeat && territoryFeat.properties && territoryFeat.properties.iso1A3
        ? territoryFeat.properties.nameEn
        : null;

    if (!iso3) {
        iso3 = countryCoder.iso1A3Code(pt);
        const countryFeat = countryCoder.feature(pt, { maxLevel: 'country' });
        if (countryFeat && countryFeat.properties) {
            if (!iso3) iso3 = countryFeat.properties.iso1A3 || null;
            nameEn = countryFeat.properties.nameEn || null;
        }
    }

    if (!iso3 && !nameEn) {
        if (lat <= -60) {
            return { codigo: 'ATA', slug: 'Antarctica', pais: 'Antarctica' };
        }
        return null;
    }

    let slug = (iso3 && ISO3_A_GCS_SLUG[iso3]) || sanitizarSlugPais(nameEn);
    if (!slug) return null;
    if (slug === 'Northern_Cyprus') slug = 'Cyprus';

    return {
        codigo: iso3 || null,
        slug,
        pais: slug.replace(/_/g, ' ')
    };
}

let cachePaises = null;
async function cargarPaisesFirms() {
    if (cachePaises) return cachePaises;
    const porNombre = new Map();
    const porCodigo = new Map();
    try {
        const countryCoder = await obtenerGeocoderPaises();
        if (countryCoder && countryCoder.borders && Array.isArray(countryCoder.borders.features)) {
            for (const f of countryCoder.borders.features) {
                const p = f && f.properties;
                if (!p || !p.iso1A3) continue;
                const codigo = String(p.iso1A3).toUpperCase();
                const slug = ISO3_A_GCS_SLUG[codigo] || sanitizarSlugPais(p.nameEn);
                const nombre = slug.replace(/_/g, ' ');
                const iso2 = p.iso1A2 ? String(p.iso1A2).toUpperCase() : '';
                const entry = { codigo, iso2, nombre, nameEn: String(p.nameEn || nombre), slug };
                porCodigo.set(codigo, entry);
                if (iso2) {
                    if (!porCodigo.has(iso2)) porCodigo.set(iso2, entry);
                }
                porNombre.set(normalizar(nombre), entry);
                if (p.nameEn) porNombre.set(normalizar(p.nameEn), entry);
                if (Array.isArray(p.aliases)) {
                    p.aliases.forEach((al) => porNombre.set(normalizar(al), entry));
                }
            }
            Object.entries(ALIAS_PAISES_EXTRA).forEach(([alias, iso3]) => {
                const info = porCodigo.get(iso3);
                if (info) porNombre.set(normalizar(alias), info);
            });
            cachePaises = { porNombre, porCodigo };
            log('INFO', `Catálogo offline de países cargado: ${porCodigo.size}`);
            return cachePaises;
        }
    } catch (e) {
        logError('cargarPaisesFirms', e);
    }
    return { porNombre, porCodigo };
}

async function resolverPais(entrada) {
    try {
        const { porNombre, porCodigo } = await cargarPaisesFirms();
        const limpio = String(entrada || '').trim();
        if (/^[A-Za-z]{2,3}$/.test(limpio)) {
            const codigo = limpio.toUpperCase();
            const info = porCodigo.get(codigo);
            return { codigo: info ? info.codigo : codigo, nombre: info ? info.nombre : limpio };
        }
        const info = porNombre.get(normalizar(limpio));
        return { codigo: info ? info.codigo : null, nombre: info ? info.nombre : limpio };
    } catch (error) {
        logError(`resolverPais(${entrada})`, error);
        return { codigo: null, nombre: String(entrada || '').trim() };
    }
}

async function buscarArchivoPais(archivos, paisEntrada) {
    try {
        const buscadoNorm = normalizar(paisEntrada);
        let archivo = archivos.find(a => normalizar(a.pais) === buscadoNorm);
        if (archivo) return archivo;

        const { nombre } = await resolverPais(paisEntrada);
        if (nombre) {
            archivo = archivos.find(a => normalizar(a.pais) === normalizar(nombre));
        }
        return archivo || null;
    } catch (error) {
        logError(`buscarArchivoPais(${paisEntrada})`, error);
        return null;
    }
}

function formatearClaveBbox(bbox) {
    if (!bbox) return '';
    return `${bbox.south.toFixed(2)},${bbox.west.toFixed(2)},${bbox.north.toFixed(2)},${bbox.east.toFixed(2)}`;
}

function construirClaveArea({ paisFiltro, bbox }) {
    const pKey = paisFiltro ? normalizar(paisFiltro) : '';
    const bKey = formatearClaveBbox(bbox);
    if (pKey && bKey) return `${pKey}@${bKey}`;
    if (pKey) return pKey;
    if (bKey) return `bbox:${bKey}`;
    return 'global';
}

// Estima qué archivos de país en GCS pueden intersectar un bbox para evitar escanear los 190 países
async function resolverPaisesPorBbox(bbox) {
    try {
        if (!bbox) return null;
        const latSpan = Math.abs(bbox.north - bbox.south);
        if (latSpan > 45 || bbox.west > bbox.east) return null;
        const lonSpan = Math.abs(bbox.east - bbox.west);
        if (lonSpan > 60) return null;

        const countryCoder = await obtenerGeocoderPaises();
        if (!countryCoder) return null;

        const encontrados = new Map();
        const pasos = 6;
        for (let i = 0; i <= pasos; i++) {
            const lat = bbox.south + ((bbox.north - bbox.south) * i) / pasos;
            for (let j = 0; j <= pasos; j++) {
                const lon = bbox.west + ((bbox.east - bbox.west) * j) / pasos;
                const info = clasificarPaisPorCoordenada(countryCoder, lat, lon);
                if (info && info.pais) {
                    encontrados.set(normalizar(info.pais), info.pais);
                }
            }
        }
        if (encontrados.size > 12) return null;
        return Array.from(encontrados.values());
    } catch (error) {
        logError('resolverPaisesPorBbox', error);
        return null;
    }
}

async function seleccionarArchivosPorArea(archivosMes, paisFiltro, bbox, paisesBbox) {
    if (!Array.isArray(archivosMes) || archivosMes.length === 0) return [];
    if (paisFiltro) {
        const encontrado = await buscarArchivoPais(archivosMes, paisFiltro);
        return encontrado ? [encontrado] : [];
    }
    if (bbox && Array.isArray(paisesBbox)) {
        if (paisesBbox.length === 0) return [];
        const vistos = new Set();
        const resultado = [];
        for (const pNombre of paisesBbox) {
            const arch = await buscarArchivoPais(archivosMes, pNombre);
            if (arch && !vistos.has(arch.nombre)) {
                vistos.add(arch.nombre);
                resultado.push(arch);
            }
        }
        return resultado;
    }
    return archivosMes;
}

function invalidarCacheResumenMes(anio, mes) {
    const prefijo = `${anio}-${mes}:`;
    for (const key of resumenMesCache.keys()) {
        if (key.startsWith(prefijo)) {
            resumenMesCache.delete(key);
        }
    }
}

async function sincronizarGruposPorPaisEnGcs(fechaHoy, filasConPais, archivosExistentes = null) {
    if (!storage || gcpConfigError) {
        log('WARN', 'GCS no configurado; se omite guardado de CSVs por país.');
        return { archivosActualizados: 0, archivosCreados: 0, registrosNuevos: 0 };
    }

    const [anio, mes] = fechaHoy.split('-');
    const porPais = new Map();
    for (const fila of filasConPais) {
        const pais = String(fila.country || '').trim();
        if (!pais) continue;
        const slug = sanitizarSlugPais(pais);
        if (!slug || normalizar(pais) === 'world') continue;
        let grupo = porPais.get(slug);
        if (!grupo) {
            grupo = { slug, pais, filas: [] };
            porPais.set(slug, grupo);
        }
        grupo.filas.push(fila);
    }

    if (porPais.size === 0) {
        return { archivosActualizados: 0, archivosCreados: 0, registrosNuevos: 0 };
    }

    const archivosMes = Array.isArray(archivosExistentes)
        ? archivosExistentes
        : await listarArchivosMes(anio, mes);
    const existentesPorSlug = new Map();
    for (const a of archivosMes) {
        existentesPorSlug.set(sanitizarSlugPais(a.pais).toLowerCase(), a);
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const grupos = Array.from(porPais.values());
    let archivosActualizados = 0;
    let archivosCreados = 0;
    let registrosNuevos = 0;

    await conLimite(grupos, CONCURRENCIA_GCS_SYNC, async (grupo) => {
        const nombreArchivo = `${anio}_${mes}_${grupo.slug}.csv`;
        const existente = existentesPorSlug.get(grupo.slug.toLowerCase());
        const file = existente ? existente.file : bucket.file(nombreArchivo);

        const mapaUnico = new Map();
        let cantidadPrevia = 0;

        if (existente) {
            const previos = [];
            await leerCsvGcs(file, (row) => {
                previos.push({ ...row, country: row.country || existente.pais });
            });
            cantidadPrevia = previos.length;
            previos.forEach((r) => mapaUnico.set(claveRegistro(r), r));
        }

        let nuevosEnPais = 0;
        for (const r of grupo.filas) {
            const k = claveRegistro(r);
            if (!mapaUnico.has(k)) {
                mapaUnico.set(k, r);
                nuevosEnPais++;
            }
        }

        if (existente && nuevosEnPais === 0) {
            return;
        }

        const registrosFinales = Array.from(mapaUnico.values());
        if (registrosFinales.length === 0) return;

        await file.save(generarCsv(registrosFinales, ESQUEMA), {
            resumable: false,
            contentType: 'text/csv; charset=utf-8'
        });

        registrosNuevos += nuevosEnPais;
        if (existente) {
            archivosActualizados++;
            log('INFO', `CSV actualizado en GCS: ${file.name} (${cantidadPrevia} -> ${registrosFinales.length} registros, +${nuevosEnPais})`);
        } else {
            archivosCreados++;
        }
    });

    if (archivosActualizados > 0 || archivosCreados > 0) {
        invalidarCacheResumenMes(anio, mes);
    }

    log(
        'INFO',
        `Sincronización GCS ${fechaHoy}: ${grupos.length} países clasificados; ${archivosCreados} CSVs creados, ${archivosActualizados} actualizados (+${registrosNuevos} nuevos registros)`
    );
    return { archivosActualizados, archivosCreados, registrosNuevos };
}

async function sincronizarPais(fechaHoy, pais, archivos) {
    try {
        if (!NASA_MAP_KEY) {
            log('ERROR', 'NASA_MAP_KEY vacío: no se puede sincronizar.');
            return null;
        }
        const { nombre } = await resolverPais(pais);
        const objetivoNorm = normalizar(nombre || pais);

        // Obtiene los datos mundiales de hoy de la NASA, los divide por país y guarda en GCS
        await obtenerMundoHoy(fechaHoy, archivos);

        const [anio, mes] = fechaHoy.split('-');
        const archivosActualizados = await listarArchivosMes(anio, mes);
        const archivo = archivosActualizados.find(a =>
            normalizar(a.pais) === objetivoNorm || normalizar(a.pais) === normalizar(pais));
        if (!archivo) {
            return [];
        }

        const registros = [];
        await leerCsvGcs(archivo.file, (row) => registros.push({ ...row, country: row.country || archivo.pais }));
        return registros;
    } catch (error) {
        logError('sincronizarPais', error);
        return null;
    }
}

let cacheMundoHoy = { fecha: null, ts: 0, filas: [], promesa: null };
async function obtenerMundoHoy(fechaHoy, archivosExistentes = null) {
    if (!NASA_MAP_KEY) return [];
    if (cacheMundoHoy.fecha === fechaHoy && Date.now() - cacheMundoHoy.ts < TTL_MUNDO_HOY_MS) {
        log('INFO', `Usando caché de NASA mundial (${cacheMundoHoy.filas.length} filas)`);
        return cacheMundoHoy.filas;
    }
    if (cacheMundoHoy.promesa && cacheMundoHoy.fecha === fechaHoy) {
        return await cacheMundoHoy.promesa;
    }

    const tarea = (async () => {
        try {
            const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_MAP_KEY}/${FUENTE_NASA}/world/1`;
            const [filas, countryCoder] = await Promise.all([
                pedirCsvNasa(url),
                obtenerGeocoderPaises()
            ]);
            if (!filas) return [];

            const deHoy = [];
            for (const r of filas) {
                if (r.acq_date !== fechaHoy) continue;
                const mapped = nasaAEsquema(r);
                if (!mapped) continue;
                const info = clasificarPaisPorCoordenada(countryCoder, mapped.latitude, mapped.longitude);
                if (info) {
                    mapped.country = info.pais;
                }
                deHoy.push(mapped);
            }

            log('INFO', `NASA mundial: ${filas.length} filas, ${deHoy.length} de ${fechaHoy} clasificadas por país`);

            try {
                await sincronizarGruposPorPaisEnGcs(fechaHoy, deHoy, archivosExistentes);
            } catch (syncErr) {
                logError('sincronizarGruposPorPaisEnGcs', syncErr);
            }

            cacheMundoHoy = { fecha: fechaHoy, ts: Date.now(), filas: deHoy, promesa: null };
            return deHoy;
        } catch (error) {
            logError('obtenerMundoHoy', error);
            cacheMundoHoy.promesa = null;
            return [];
        }
    })();

    cacheMundoHoy = { fecha: fechaHoy, ts: 0, filas: [], promesa: tarea };
    return await tarea;
}

let cacheMundo48h = { fechaBase: null, ts: 0, filas: [] };
async function obtenerMundoPorFechaReciente(fechaObjetivo) {
    if (!NASA_MAP_KEY) return [];
    const hoy = obtenerFechaHoy();
    if (fechaObjetivo === hoy) return obtenerMundoHoy(hoy);

    if (cacheMundo48h.fechaBase === hoy && Date.now() - cacheMundo48h.ts < TTL_MUNDO_HOY_MS) {
        return cacheMundo48h.filas.filter(r => fechaDe(r) === fechaObjetivo);
    }
    try {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_MAP_KEY}/${FUENTE_NASA}/world/2`;
        const [filas, countryCoder] = await Promise.all([
            pedirCsvNasa(url),
            obtenerGeocoderPaises()
        ]);
        if (!filas) return [];
        const mapeadas = [];
        for (const r of filas) {
            const mapped = nasaAEsquema(r);
            if (!mapped) continue;
            const info = clasificarPaisPorCoordenada(countryCoder, mapped.latitude, mapped.longitude);
            if (info) {
                mapped.country = info.pais;
            }
            mapeadas.push(mapped);
        }
        cacheMundo48h = { fechaBase: hoy, ts: Date.now(), filas: mapeadas };
        return mapeadas.filter(r => fechaDe(r) === fechaObjetivo);
    } catch (error) {
        logError('obtenerMundoPorFechaReciente', error);
        return [];
    }
}

// ---------------------------------------------------------------
// CACHÉ MULTINIVEL (RAM COMPRIMIDA + /tmp POR DÍA + GCS _iris_cache)
// ---------------------------------------------------------------
const CACHE_MAX = 600;
const resumenMesCache = new Map();
const medianaMesCache = new Map();
const historialAnualCache = new Map();
const historialAnualPromesas = new Map();
let precalentandoGlobalPromesa = null;
const mesIndexandoPromesas = new Map();
const resumenAnioPromesas = new Map();
const gcsGuardadosEnSesion = new Set();

const ramGzCache = new Map(); // key -> { gz: Buffer, size: number }
let ramGzCacheBytes = 0;

function getRamGzCache(key) {
    const hit = ramGzCache.get(key);
    if (!hit) return null;
    // Refresca orden LRU
    ramGzCache.delete(key);
    ramGzCache.set(key, hit);
    return hit.gz;
}

function setRamGzCache(key, gzBuf) {
    if (!Buffer.isBuffer(gzBuf) || gzBuf.length > MAX_MEM_COMPRESSED_BYTES) return;
    const prev = ramGzCache.get(key);
    if (prev) {
        ramGzCache.delete(key);
        ramGzCacheBytes -= prev.size;
    }
    while (ramGzCacheBytes + gzBuf.length > MAX_MEM_COMPRESSED_BYTES && ramGzCache.size > 0) {
        const oldestKey = ramGzCache.keys().next().value;
        const oldest = ramGzCache.get(oldestKey);
        ramGzCache.delete(oldestKey);
        ramGzCacheBytes -= oldest ? oldest.size : 0;
    }
    ramGzCache.set(key, { gz: gzBuf, size: gzBuf.length });
    ramGzCacheBytes += gzBuf.length;
}

async function leerArchivoGcsBuffer(objectPath) {
    if (!storage || gcpConfigError) return null;
    try {
        const [buf] = await storage.bucket(BUCKET_NAME).file(objectPath).download();
        return buf;
    } catch (err) {
        if (err && (err.code === 404 || err.status === 404)) return null;
        return null;
    }
}

async function leerJsonGcs(objectPath) {
    const buf = await leerArchivoGcsBuffer(objectPath);
    if (!buf) return null;
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch {
        return null;
    }
}

function guardarEnGcsSegundoPlano(objectPath, contenido, contentType = 'application/json; charset=utf-8', gzipEncoded = false) {
    if (!storage || gcpConfigError || gcsGuardadosEnSesion.has(objectPath)) return;
    gcsGuardadosEnSesion.add(objectPath);
    setImmediate(async () => {
        try {
            const opts = { resumable: false, contentType };
            if (gzipEncoded) opts.metadata = { contentEncoding: 'gzip' };
            await storage.bucket(BUCKET_NAME).file(objectPath).save(contenido, opts);
            log('INFO', `Caché GCS guardado: ${objectPath}`);
        } catch (err) {
            gcsGuardadosEnSesion.delete(objectPath);
            log('WARN', `No se pudo guardar caché GCS (${objectPath}): ${err.message}`);
        }
    });
}

async function podarCacheDisco() {
    try {
        if (!fs.existsSync(TMP_CACHE_DIR)) return;
        const entries = await fs.promises.readdir(TMP_CACHE_DIR, { withFileTypes: true });
        const dirs = [];
        let totalSize = 0;

        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith('_staging_')) continue;
            const dirPath = path.join(TMP_CACHE_DIR, e.name);
            try {
                const sub = await fs.promises.readdir(dirPath);
                let dirSize = 0;
                let latestMtime = 0;
                for (const fn of sub) {
                    try {
                        const st = await fs.promises.stat(path.join(dirPath, fn));
                        dirSize += st.size;
                        if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
                    } catch {
                        // ignore file removed concurrently
                    }
                }
                totalSize += dirSize;
                dirs.push({ dirPath, dirSize, latestMtime });
            } catch {
                // ignore
            }
        }

        if (totalSize <= MAX_TMP_CACHE_BYTES) return;
        dirs.sort((a, b) => a.latestMtime - b.latestMtime);
        for (const d of dirs) {
            if (totalSize <= MAX_TMP_CACHE_BYTES * 0.8) break;
            try {
                await fs.promises.rm(d.dirPath, { recursive: true, force: true });
                totalSize -= d.dirSize;
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore pruning error
    }
}

const mesesComprimiendo = new Set();
function comprimirDiasMesEnSegundoPlano(monthDir) {
    if (!monthDir || mesesComprimiendo.has(monthDir)) return;
    mesesComprimiendo.add(monthDir);
    setTimeout(async () => {
        try {
            const entries = await fs.promises.readdir(monthDir);
            for (const name of entries) {
                if (!/^\d{2}\.csv$/.test(name)) continue;
                const src = path.join(monthDir, name);
                const dst = `${src}.gz`;
                const tmpDst = `${dst}.tmp`;
                if (fs.existsSync(dst)) {
                    try { await fs.promises.unlink(src); } catch { /* ignore */ }
                    continue;
                }
                try {
                    const raw = await fs.promises.readFile(src);
                    const gz = await gzipAsync(raw, { level: 1 });
                    await fs.promises.writeFile(tmpDst, gz);
                    await fs.promises.rename(tmpDst, dst);
                    try { await fs.promises.unlink(src); } catch { /* ignore if currently reading */ }
                } catch {
                    try { await fs.promises.rm(tmpDst, { force: true }); } catch { /* ignore */ }
                }
            }
        } catch {
            // ignore background compression errors
        } finally {
            mesesComprimiendo.delete(monthDir);
        }
    }, 1500).unref();
}

function getCached(cache, key, ttlMs) {
    try {
        const hit = cache.get(key);
        if (!hit) return null;
        if (Date.now() - hit.ts > ttlMs) {
            cache.delete(key);
            return null;
        }
        return hit.value;
    } catch (error) {
        logError('getCached', error);
        return null;
    }
}

function setCached(cache, key, value) {
    try {
        if (cache.size >= CACHE_MAX) {
            const oldestKey = cache.keys().next().value;
            cache.delete(oldestKey);
        }
        cache.set(key, { ts: Date.now(), value });
    } catch (error) {
        logError('setCached', error);
    }
}

function convertirBufferAFilasCsvCanonico(text, callback) {
    let pos = 0;
    const len = text.length;
    while (pos < len) {
        let nl = text.indexOf('\n', pos);
        if (nl === -1) nl = len;
        let end = nl;
        if (end > pos && text.charCodeAt(end - 1) === 13) end--;
        if (end > pos) {
            const line = text.slice(pos, end);
            const vals = line.indexOf('"') !== -1 ? parseCsvLineQuoted(line) : line.split(',');
            callback(vals);
        }
        pos = nl + 1;
    }
}

function valsCanonicosAObjeto(vals) {
    const obj = {};
    for (let i = 0; i < ESQUEMA_CSV.length; i++) {
        obj[ESQUEMA_CSV[i]] = vals[i] !== undefined ? vals[i] : '';
    }
    return obj;
}

function valsCanonicosACompacto(vals) {
    const out = new Array(COMPACT_IDX_CANON.length);
    for (let i = 0; i < COMPACT_IDX_CANON.length; i++) {
        const idx = COMPACT_IDX_CANON[i];
        out[i] = vals[idx] !== undefined ? vals[idx] : '';
    }
    return out;
}

async function leerDiaCacheadoTexto(monthDir, diaNum) {
    const dd = String(diaNum).padStart(2, '0');
    const gzPath = path.join(monthDir, `${dd}.csv.gz`);
    const csvPath = path.join(monthDir, `${dd}.csv`);
    if (fs.existsSync(gzPath)) {
        const gz = await fs.promises.readFile(gzPath);
        const buf = await gunzipAsync(gz);
        return buf.toString('utf8');
    }
    if (fs.existsSync(csvPath)) {
        return await fs.promises.readFile(csvPath, 'utf8');
    }
    return '';
}

async function leerMetaMesLocal(anioStr, mesStr) {
    const monthDir = path.join(TMP_CACHE_DIR, `${anioStr}-${mesStr}`);
    const metaPath = path.join(monthDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (!meta || meta.schemaVersion !== CACHE_SCHEMA_VERSION || !meta.complete) return null;
        fs.promises.utimes(metaPath, new Date(), new Date()).catch(() => {});
        return { monthDir, meta };
    } catch {
        return null;
    }
}

async function obtenerMesIndexado(anioStr, mesStr, archivosPrelistados = null) {
    const localHit = await leerMetaMesLocal(anioStr, mesStr);
    if (localHit) {
        return localHit;
    }

    const ymKey = `${anioStr}-${mesStr}`;
    if (mesIndexandoPromesas.has(ymKey)) {
        return await mesIndexandoPromesas.get(ymKey);
    }

    const tarea = (async () => {
        const t0 = Date.now();
        const monthDir = path.join(TMP_CACHE_DIR, ymKey);
        const stagingDir = path.join(TMP_CACHE_DIR, `_staging_${ymKey}_${Date.now()}`);
        const dayFds = new Array(32).fill(null);

        try {
            const archivos = Array.isArray(archivosPrelistados)
                ? archivosPrelistados
                : await listarArchivosMes(anioStr, mesStr);

            if (!archivos || archivos.length === 0) {
                return { monthDir: null, meta: null };
            }

            await fs.promises.mkdir(TMP_CACHE_DIR, { recursive: true });
            await fs.promises.mkdir(stagingDir, { recursive: true });

            const ordenados = ordenarPorTamanoDesc(archivos);
            const targetYmPrefix = `${anioStr}-${mesStr}-`;
            const nlBuf = Buffer.from('\n');

            let totalFocos = 0;
            let frpMax = 0;
            let nivelMax = 0;
            const distribucion = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
            const dias = {};
            const dayCounts = new Array(32).fill(0);

            const ensureDayFd = (dayNum) => {
                if (dayFds[dayNum] === null) {
                    const p = path.join(stagingDir, `${String(dayNum).padStart(2, '0')}.csv`);
                    dayFds[dayNum] = fs.openSync(p, 'w');
                }
                return dayFds[dayNum];
            };

            const acumularStat = (dayNum, frpVal) => {
                totalFocos++;
                dayCounts[dayNum]++;
                const nivel = clasificarNivelFrp(frpVal);
                if (Number.isFinite(frpVal) && frpVal > frpMax) frpMax = frpVal;
                if (nivel > nivelMax) nivelMax = nivel;
                distribucion[nivel]++;

                let d = dias[dayNum];
                if (!d) {
                    d = { totalFocos: 0, frpMax: 0, nivelMax: 0 };
                    dias[dayNum] = d;
                }
                d.totalFocos++;
                if (Number.isFinite(frpVal) && frpVal > d.frpMax) d.frpMax = frpVal;
                if (nivel > d.nivelMax) d.nivelMax = nivel;
            };

            await conLimite(ordenados, CONCURRENCIA_GCS_INDEX, async (item) => {
                let headerParsed = false;
                let esEstandar11 = false;
                let esEstandar12 = false;
                let colMap = null;
                let iDate = -1;
                let iFrp = -1;
                let iAcqTime = -1;
                const countryEsc = escaparCsv(item.pais);
                const countrySuffixBuf = Buffer.from(`,${countryEsc}\n`, 'utf8');

                const onChunk = (chunkDayBufs) => {
                    for (let d = 1; d <= 31; d++) {
                        if (chunkDayBufs[d] && chunkDayBufs[d].length > 0) {
                            fs.writeSync(ensureDayFd(d), Buffer.concat(chunkDayBufs[d]));
                        }
                    }
                };

                let chunkDayBufs = new Array(32);

                await escanearLineasStream(item.file.createReadStream(), (buf, start, end) => {
                    if (!headerParsed) {
                        headerParsed = true;
                        const hLine = buf.toString('utf8', start, end).trim();
                        if (hLine === HEADER_ESTANDAR_ESQUEMA) {
                            esEstandar11 = true;
                            iDate = 5;
                            iFrp = 6;
                            return;
                        }
                        if (hLine === HEADER_ESTANDAR_CSV) {
                            esEstandar12 = true;
                            iDate = 5;
                            iFrp = 6;
                            return;
                        }
                        const rawCols = (hLine.indexOf('"') !== -1 ? parseCsvLineQuoted(hLine) : hLine.split(','))
                            .map(c => c.trim().toLowerCase());
                        iDate = rawCols.indexOf('datetime');
                        if (iDate < 0) iDate = rawCols.indexOf('acq_date');
                        iAcqTime = rawCols.indexOf('acq_time');
                        iFrp = rawCols.indexOf('frp');
                        colMap = ESQUEMA_CSV.map((name) => rawCols.indexOf(name));
                        return;
                    }

                    if (iDate < 0) return;
                    const tieneComillas = buf.subarray(start, end).indexOf(0x22) !== -1;

                    if ((esEstandar11 || esEstandar12) && !tieneComillas) {
                        let curCol = 0;
                        let colStart = start;
                        let dPos = -1;
                        let dEnd = -1;
                        let fPos = -1;
                        let fEnd = -1;
                        for (let k = start; k <= end; k++) {
                            if (k === end || buf[k] === 0x2c) {
                                if (curCol === 5) {
                                    dPos = colStart;
                                    dEnd = k;
                                } else if (curCol === 6) {
                                    fPos = colStart;
                                    fEnd = k;
                                    break;
                                }
                                curCol++;
                                colStart = k + 1;
                            }
                        }
                        if (dPos >= 0 && dEnd - dPos >= 10) {
                            const ymSlice = buf.toString('ascii', dPos, dPos + 8);
                            if (ymSlice === targetYmPrefix) {
                                const dayNum = ((buf[dPos + 8] - 48) * 10) + (buf[dPos + 9] - 48);
                                if (dayNum >= 1 && dayNum <= 31) {
                                    const frpVal = fPos >= 0 && fEnd > fPos
                                        ? parseFloat(buf.toString('ascii', fPos, fEnd))
                                        : NaN;
                                    acumularStat(dayNum, frpVal);
                                    if (!chunkDayBufs[dayNum]) chunkDayBufs[dayNum] = [];
                                    chunkDayBufs[dayNum].push(buf.subarray(start, end));
                                    chunkDayBufs[dayNum].push(esEstandar12 ? nlBuf : countrySuffixBuf);
                                    if (chunkDayBufs[dayNum].length >= 1024) {
                                        fs.writeSync(ensureDayFd(dayNum), Buffer.concat(chunkDayBufs[dayNum]));
                                        chunkDayBufs[dayNum] = [];
                                    }
                                }
                            }
                        }
                        return;
                    }

                    // Respaldo general si el archivo tiene columnas distintas o comillas
                    const rawLine = buf.toString('utf8', start, end);
                    const vals = tieneComillas ? parseCsvLineQuoted(rawLine) : rawLine.split(',');
                    const fechaRaw = String(vals[iDate] || '').trim();
                    if (!fechaRaw.startsWith(targetYmPrefix)) return;
                    const dayNum = parseInt(fechaRaw.slice(8, 10), 10);
                    if (!(dayNum >= 1 && dayNum <= 31)) return;
                    const frpVal = iFrp >= 0 ? parseFloat(vals[iFrp]) : NaN;
                    acumularStat(dayNum, frpVal);

                    const canon = new Array(ESQUEMA_CSV.length);
                    for (let c = 0; c < ESQUEMA_CSV.length; c++) {
                        const srcIdx = colMap ? colMap[c] : -1;
                        canon[c] = srcIdx >= 0 && vals[srcIdx] !== undefined ? vals[srcIdx] : '';
                    }
                    if (!canon[5] && fechaRaw) {
                        const hhmm = iAcqTime >= 0 ? String(vals[iAcqTime] || '').padStart(4, '0') : '0000';
                        canon[5] = `${fechaRaw.slice(0, 10)} ${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`;
                    }
                    if (!canon[11]) canon[11] = item.pais;
                    const canonLine = `${canon.map(escaparCsv).join(',')}\n`;
                    if (!chunkDayBufs[dayNum]) chunkDayBufs[dayNum] = [];
                    chunkDayBufs[dayNum].push(Buffer.from(canonLine, 'utf8'));
                });

                onChunk(chunkDayBufs);
                chunkDayBufs = [];
            });

            for (let d = 1; d <= 31; d++) {
                if (dayFds[d] !== null) {
                    fs.closeSync(dayFds[d]);
                    dayFds[d] = null;
                }
            }

            const resumenMesObj = {
                mes: parseInt(mesStr, 10),
                totalFocos,
                frpMax: totalFocos > 0 ? Math.round(frpMax * 100) / 100 : 0,
                nivelMaximo: totalFocos > 0 ? nivelMax : 0,
                intensidadMaxima: totalFocos > 0 ? nombreIntensidad(nivelMax) : 'Sin datos',
                distribucion,
                dias
            };
            setCached(resumenMesCache, `${ymKey}:global`, resumenMesObj);

            const meta = {
                schemaVersion: CACHE_SCHEMA_VERSION,
                anio: parseInt(anioStr, 10),
                mes: parseInt(mesStr, 10),
                totalFocos,
                frpMax: resumenMesObj.frpMax,
                nivelMaximo: resumenMesObj.nivelMaximo,
                intensidadMaxima: resumenMesObj.intensidadMaxima,
                distribucion,
                dias,
                dayCounts,
                filesCount: archivos.length,
                complete: true,
                createdAt: Date.now()
            };

            await fs.promises.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(meta));
            if (fs.existsSync(monthDir)) {
                await fs.promises.rm(monthDir, { recursive: true, force: true });
            }
            await fs.promises.rename(stagingDir, monthDir);

            log('INFO', `Índice mensual ${ymKey} construido en ${Date.now() - t0} ms (${totalFocos} focos, ${archivos.length} archivos)`);
            podarCacheDisco().catch(() => {});
            comprimirDiasMesEnSegundoPlano(monthDir);

            return { monthDir, meta };
        } catch (err) {
            logError(`obtenerMesIndexado(${ymKey})`, err);
            try { await fs.promises.rm(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
            throw err;
        } finally {
            for (let d = 1; d <= 31; d++) {
                if (dayFds[d] !== null) {
                    try { fs.closeSync(dayFds[d]); } catch { /* ignore */ }
                    dayFds[d] = null;
                }
            }
        }
    })();

    mesIndexandoPromesas.set(ymKey, tarea);
    try {
        return await tarea;
    } finally {
        mesIndexandoPromesas.delete(ymKey);
    }
}

async function construirMuestraMesDesdeCache(monthDir, meta, limite) {
    const total = meta.totalFocos || 0;
    const rowsCompact = [];

    if (total === 0) {
        return { rowsCompact, totalRegistros: 0, truncado: false };
    }

    if (total <= limite) {
        for (let d = 1; d <= 31; d++) {
            if (!meta.dayCounts || !meta.dayCounts[d]) continue;
            const texto = await leerDiaCacheadoTexto(monthDir, d);
            convertirBufferAFilasCsvCanonico(texto, (vals) => {
                rowsCompact.push(valsCanonicosACompacto(vals));
            });
        }
        return { rowsCompact, totalRegistros: total, truncado: false };
    }

    // Muestreo estratificado equilibrado por día y país (preservando focos extremos de alta intensidad)
    const activeDays = [];
    for (let d = 1; d <= 31; d++) {
        if (meta.dayCounts && meta.dayCounts[d] > 0) activeDays.push(d);
    }

    const quotas = new Map();
    let assigned = 0;
    for (const d of activeDays) {
        const q = Math.max(1, Math.floor((meta.dayCounts[d] / total) * limite));
        quotas.set(d, q);
        assigned += q;
    }
    let rem = limite - assigned;
    for (let i = 0; i < activeDays.length && rem > 0; i++) {
        const d = activeDays[i];
        quotas.set(d, quotas.get(d) + 1);
        rem--;
    }

    for (const d of activeDays) {
        const qDay = quotas.get(d) || 0;
        if (qDay <= 0) continue;
        const dayTotal = meta.dayCounts[d];
        const texto = await leerDiaCacheadoTexto(monthDir, d);
        if (!texto) continue;

        if (dayTotal <= qDay) {
            convertirBufferAFilasCsvCanonico(texto, (vals) => {
                rowsCompact.push(valsCanonicosACompacto(vals));
            });
            continue;
        }

        // Reserva hasta 20% del cupo diario para focos de alta intensidad (FRP >= 150) y reparte el resto uniformemente
        const highMax = qDay >= 5 ? Math.floor(qDay * 0.2) : 0;
        const highRows = [];
        const step = dayTotal / qDay;
        let nextTarget = 0;
        let idx = 0;
        const pickedRegular = [];

        convertirBufferAFilasCsvCanonico(texto, (vals) => {
            const frp = parseFloat(vals[6]);
            if (highMax > 0 && Number.isFinite(frp) && frp >= 150 && highRows.length < highMax) {
                highRows.push(valsCanonicosACompacto(vals));
            } else if (pickedRegular.length < qDay && idx >= Math.floor(nextTarget)) {
                pickedRegular.push(valsCanonicosACompacto(vals));
                nextTarget += step;
            }
            idx++;
        });

        for (const r of highRows) rowsCompact.push(r);
        const regTarget = Math.min(pickedRegular.length, Math.max(0, qDay - highRows.length));
        if (pickedRegular.length <= regTarget) {
            for (const r of pickedRegular) rowsCompact.push(r);
        } else if (regTarget > 0) {
            for (let i = 0; i < regTarget; i++) {
                rowsCompact.push(pickedRegular[Math.floor((i * pickedRegular.length) / regTarget)]);
            }
        }
    }

    return {
        rowsCompact,
        totalRegistros: total,
        truncado: total > rowsCompact.length
    };
}

function construirPayloadApiIncendios({ esCompacto, fecha, anio, mes, pais, bbox, radio, paisesLeidos, totalRegistros, rowsCompact, dataObjetos, truncado }) {
    const base = {
        filtrosAplicados: {
            fecha: fecha || 'Todo el mes',
            mes: `${anio}-${mes}`,
            pais: pais || 'Global',
            bbox: bbox || null,
            radio: radio || null
        },
        paisesIncluidos: paisesLeidos,
        totalRegistros,
        devueltos: esCompacto ? rowsCompact.length : dataObjetos.length,
        truncado
    };
    if (esCompacto) {
        return {
            ...base,
            compact: true,
            columns: COMPACT_COLS,
            rows: rowsCompact
        };
    }
    return {
        ...base,
        data: dataObjetos
    };
}

const compactARegistrosObjeto = (rowsCompact) =>
    rowsCompact.map((r) => ({
        latitude: r[0],
        longitude: r[1],
        scan: r[2],
        confidence: r[3],
        daynight: r[4],
        datetime: r[5],
        frp: r[6],
        sensor: r[7],
        frp_log_norm: r[8],
        country: r[9]
    }));

async function cargarResumenAnioDesdeGcs(anioStr) {
    const anioNum = parseInt(anioStr, 10);
    const cacheObject = `${GCS_CACHE_PREFIX}/resumen_${anioStr}.json`;
    const doc = await leerJsonGcs(cacheObject);
    if (!doc || doc.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(doc.meses) || doc.meses.length !== 12) {
        return null;
    }
    for (const m of doc.meses) {
        if (!m || !m.mes) continue;
        const mStr = String(m.mes).padStart(2, '0');
        setCached(resumenMesCache, `${anioStr}-${mStr}:global`, m);
    }
    return doc;
}

async function calcularResumenMes({ anioStr, mesStr, archivosMes, paisFiltro, bbox = null, paisesBbox = null, incluirDias, fechaHoy }) {
    try {
        const esMesActual = `${anioStr}-${mesStr}` === fechaHoy.slice(0, 7);
        const areaKey = construirClaveArea({ paisFiltro, bbox });
        const cacheKey = `${anioStr}-${mesStr}:${areaKey}`;
        const ttl = esMesActual ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000;

        const cached = getCached(resumenMesCache, cacheKey, ttl);
        if (cached && (!incluirDias || cached.dias !== null)) {
            return cached;
        }

        // Si es un mes histórico global, verifica primero el índice local de /tmp o créalo una sola vez
        if (!esMesActual && !paisFiltro && !bbox && archivosMes && archivosMes.length > 0 && incluirDias) {
            try {
                const { meta } = await obtenerMesIndexado(anioStr, mesStr, archivosMes);
                if (meta) {
                    const hitAfter = getCached(resumenMesCache, cacheKey, ttl);
                    if (hitAfter && hitAfter.dias !== null) return hitAfter;
                }
            } catch {
                // fallback a escaneo directo
            }
        }

        let archivosObjetivo = await seleccionarArchivosPorArea(archivosMes, paisFiltro, bbox, paisesBbox);
        archivosObjetivo = ordenarPorTamanoDesc(archivosObjetivo);

        let totalFocos = 0;
        let frpMax = 0;
        let sumFrp = 0;
        let frpValidCount = 0;
        let nivelMax = 0;
        const distribucion = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        const diasMap = incluirDias ? new Map() : null;
        const clavesHoy = esMesActual ? new Set() : null;

        const acumular = (fechaStr, frpRaw, latLonKey = null) => {
            totalFocos++;
            const frp = parseFloat(frpRaw);
            const nivel = clasificarNivelFrp(frp);
            if (Number.isFinite(frp)) {
                if (frp > frpMax) frpMax = frp;
                sumFrp += frp;
                frpValidCount++;
            }
            if (nivel > nivelMax) nivelMax = nivel;
            distribucion[nivel]++;

            if (diasMap && fechaStr && fechaStr.length >= 10) {
                const diaNum = parseInt(fechaStr.slice(8, 10), 10);
                if (diaNum >= 1 && diaNum <= 31) {
                    let d = diasMap.get(diaNum);
                    if (!d) {
                        d = { totalFocos: 0, frpMax: 0, nivelMax: 0 };
                        diasMap.set(diaNum, d);
                    }
                    d.totalFocos++;
                    if (Number.isFinite(frp) && frp > d.frpMax) d.frpMax = frp;
                    if (nivel > d.nivelMax) d.nivelMax = nivel;
                }
            }
            if (clavesHoy && latLonKey) clavesHoy.add(latLonKey);
        };

        if (esMesActual && !paisFiltro) {
            // Necesitamos claves de hoy para deduplicar con NASA en vivo
            await conLimite(archivosObjetivo, CONCURRENCIA_GCS, async (a) => {
                await leerCsvGcs(a.file, (row) => {
                    if (bbox && !puntoEnBbox(parseFloat(row.latitude), parseFloat(row.longitude), bbox)) return;
                    const f = fechaDe(row);
                    const clave = f === fechaHoy ? claveRegistro(row) : null;
                    acumular(f, row.frp, clave);
                });
            });

            const vivos = await obtenerMundoHoy(fechaHoy);
            vivos.forEach((r) => {
                if (bbox && !puntoEnBbox(parseFloat(r.latitude), parseFloat(r.longitude), bbox)) return;
                if (!clavesHoy.has(claveRegistro(r))) {
                    acumular(fechaDe(r), r.frp);
                }
            });
        } else if (esMesActual && paisFiltro) {
            const sincronizados = await sincronizarPais(fechaHoy, paisFiltro, archivosMes);
            if (sincronizados) {
                sincronizados.forEach((r) => {
                    if (bbox && !puntoEnBbox(parseFloat(r.latitude), parseFloat(r.longitude), bbox)) return;
                    acumular(fechaDe(r), r.frp);
                });
            } else {
                await conLimite(archivosObjetivo, CONCURRENCIA_GCS, async (a) => {
                    await escanearCsvResumenConCoordsGcs(a.file, bbox, (fechaStr, frpRaw) => {
                        acumular(String(fechaStr || '').slice(0, 10), frpRaw);
                    });
                });
            }
        } else {
            await conLimite(archivosObjetivo, CONCURRENCIA_GCS, async (a) => {
                await escanearCsvResumenConCoordsGcs(a.file, bbox, (fechaStr, frpRaw) => {
                    acumular(String(fechaStr || '').slice(0, 10), frpRaw);
                });
            });
        }

        const resultado = {
            mes: parseInt(mesStr, 10),
            totalFocos,
            frpMax: totalFocos > 0 ? Math.round(frpMax * 100) / 100 : 0,
            frpAvg: frpValidCount > 0 ? Math.round((sumFrp / frpValidCount) * 100) / 100 : 0,
            nivelMaximo: totalFocos > 0 ? nivelMax : 0,
            intensidadMaxima: totalFocos > 0 ? nombreIntensidad(nivelMax) : 'Sin datos',
            distribucion,
            dias: diasMap ? Object.fromEntries(diasMap) : null
        };

        setCached(resumenMesCache, cacheKey, resultado);
        return resultado;
    } catch (error) {
        logError(`calcularResumenMes(${anioStr}-${mesStr})`, error);
        throw error;
    }
}

function calcularMediana(valores) {
    if (!valores.length) return 0;
    const ordenados = valores.slice().sort((a, b) => a - b);
    const mitad = Math.floor(ordenados.length / 2);
    if (ordenados.length % 2 === 1) return ordenados[mitad];
    return Math.round(((ordenados[mitad - 1] + ordenados[mitad]) / 2) * 100) / 100;
}

function calcularPromedio(valores) {
    if (!valores.length) return 0;
    const suma = valores.reduce((acc, v) => acc + v, 0);
    return Math.round((suma / valores.length) * 100) / 100;
}

async function calcularMedianaHistoricaMes({ mesStr, paisFiltro, bbox = null, paisesBbox = null, anioActualMax, mesActualDatos }) {
    try {
        const esGlobalPuro = !paisFiltro && !bbox;
        const areaKey = construirClaveArea({ paisFiltro, bbox });
        const cacheKey = `${mesStr}:${areaKey}`;
        const cached = getCached(medianaMesCache, cacheKey, 6 * 60 * 60 * 1000);
        if (cached) return cached;

        const mesIdx = parseInt(mesStr, 10) - 1;
        const medianaGcsKey = esGlobalPuro ? `${GCS_CACHE_PREFIX}/mediana_${mesStr}.json` : null;
        let porAnioPersistido = {};

        // 1. Revisa si la mediana histórica ya existe persistida en GCS
        if (medianaGcsKey) {
            const docMed = await leerJsonGcs(medianaGcsKey);
            if (docMed && docMed.schemaVersion === CACHE_SCHEMA_VERSION && docMed.porAnio) {
                porAnioPersistido = docMed.porAnio;
                if (docMed.completo) {
                    const valores = Object.entries(porAnioPersistido)
                        .filter(([y]) => parseInt(y, 10) < anioActualMax)
                        .map(([, v]) => Number(v))
                        .filter((v) => v > 0);
                    if (mesActualDatos && mesActualDatos.anio === anioActualMax && mesActualDatos.totalFocos > 0) {
                        valores.push(mesActualDatos.totalFocos);
                    } else if (porAnioPersistido[anioActualMax] > 0) {
                        valores.push(Number(porAnioPersistido[anioActualMax]));
                    }
                    const resultado = {
                        mediana: calcularMediana(valores),
                        promedio: calcularPromedio(valores),
                        aniosAnalizados: valores.length
                    };
                    setCached(medianaMesCache, cacheKey, resultado);
                    return resultado;
                }
            }
        }

        const anios = [];
        for (let y = ANIO_MINIMO_GCS; y <= anioActualMax; y++) anios.push(y);

        // 2. Si es global, revisa primero resúmenes anuales ya guardados en GCS (~150 ms)
        if (esGlobalPuro) {
            const faltantesResumen = anios.filter((y) => y < anioActualMax && porAnioPersistido[String(y)] === undefined);
            await conLimite(faltantesResumen, 12, async (y) => {
                const resumenDoc = await cargarResumenAnioDesdeGcs(String(y));
                if (resumenDoc && resumenDoc.meses && resumenDoc.meses[mesIdx]) {
                    porAnioPersistido[String(y)] = resumenDoc.meses[mesIdx].totalFocos || 0;
                }
            });
        }

        // 3. Lista en paralelo solo los años que aún falten contar
        const aniosPorListar = anios.filter((y) => {
            if (mesActualDatos && y === mesActualDatos.anio) return false;
            if (esGlobalPuro && porAnioPersistido[String(y)] !== undefined) return false;
            const hit = getCached(resumenMesCache, `${y}-${mesStr}:${areaKey}`, 6 * 60 * 60 * 1000);
            if (hit) {
                if (esGlobalPuro && y < anioActualMax) porAnioPersistido[String(y)] = hit.totalFocos;
                return false;
            }
            return true;
        });

        const archivosPorAnio = new Map();
        if (aniosPorListar.length > 0) {
            await conLimite(aniosPorListar, 12, async (y) => {
                const archivos = await listarArchivosMes(String(y), mesStr);
                if (archivos.length > 0) {
                    archivosPorAnio.set(y, archivos);
                } else if (esGlobalPuro && y < anioActualMax) {
                    porAnioPersistido[String(y)] = 0;
                }
            });
        }

        const inicio = Date.now();
        const PRESUPUESTO_MS = 24000;
        let presupuestoAgotado = false;
        const aniosPendientesConteo = Array.from(archivosPorAnio.keys()).sort((a, b) => a - b);

        // Ejecuta conteo de años pendientes en lotes paralelos
        await conLimite(aniosPendientesConteo, 3, async (y) => {
            if (presupuestoAgotado) return;
            if (Date.now() - inicio > PRESUPUESTO_MS && (Object.keys(porAnioPersistido).length >= 5 || !esGlobalPuro)) {
                presupuestoAgotado = true;
                return;
            }
            const archivos = archivosPorAnio.get(y);
            const objetivo = await seleccionarArchivosPorArea(archivos, paisFiltro, bbox, paisesBbox);
            if (!objetivo.length) {
                if (esGlobalPuro && y < anioActualMax) porAnioPersistido[String(y)] = 0;
                else setCached(resumenMesCache, `${y}-${mesStr}:${areaKey}:countOnly`, 0);
                return;
            }

            let totalAnio = 0;
            if (bbox) {
                await conLimite(ordenarPorTamanoDesc(objetivo), CONCURRENCIA_GCS_MEDIANA, async (a) => {
                    let count = 0;
                    await escanearCsvResumenConCoordsGcs(a.file, bbox, () => {
                        count++;
                    });
                    totalAnio += count;
                });
            } else {
                await conLimite(ordenarPorTamanoDesc(objetivo), CONCURRENCIA_GCS_MEDIANA, async (a) => {
                    totalAnio += await contarFilasCsvGcs(a.file);
                });
            }
            if (esGlobalPuro && y < anioActualMax) {
                porAnioPersistido[String(y)] = totalAnio;
            } else {
                setCached(resumenMesCache, `${y}-${mesStr}:${areaKey}:countOnly`, totalAnio);
            }
        });

        if (presupuestoAgotado) {
            log('WARN', `Presupuesto de mediana alcanzado para mes ${mesStr} (${areaKey})`);
        }

        const conteosPorAnio = [];
        for (const y of anios) {
            if (mesActualDatos && y === mesActualDatos.anio) {
                if (mesActualDatos.totalFocos > 0) conteosPorAnio.push(mesActualDatos.totalFocos);
                continue;
            }
            if (esGlobalPuro && porAnioPersistido[String(y)] !== undefined) {
                const val = Number(porAnioPersistido[String(y)]);
                if (val > 0) conteosPorAnio.push(val);
                continue;
            }
            const cachedMes = getCached(resumenMesCache, `${y}-${mesStr}:${areaKey}`, 6 * 60 * 60 * 1000);
            if (cachedMes && cachedMes.totalFocos > 0) {
                conteosPorAnio.push(cachedMes.totalFocos);
                continue;
            }
            const countOnly = getCached(resumenMesCache, `${y}-${mesStr}:${areaKey}:countOnly`, 6 * 60 * 60 * 1000);
            if (countOnly && countOnly > 0) conteosPorAnio.push(countOnly);
        }

        // Persiste progreso en GCS para acelerar todas las futuras consultas del mismo mes
        if (medianaGcsKey && Object.keys(porAnioPersistido).length > 0) {
            const todosPasadosListos = !presupuestoAgotado && anios.filter(y => y < anioActualMax).every(y => porAnioPersistido[String(y)] !== undefined);
            guardarEnGcsSegundoPlano(medianaGcsKey, JSON.stringify({
                schemaVersion: CACHE_SCHEMA_VERSION,
                mes: mesStr,
                completo: todosPasadosListos,
                porAnio: porAnioPersistido
            }));
        }

        const resultado = {
            mediana: calcularMediana(conteosPorAnio),
            promedio: calcularPromedio(conteosPorAnio),
            aniosAnalizados: conteosPorAnio.length
        };
        if (conteosPorAnio.length > 0 && !presupuestoAgotado) {
            setCached(medianaMesCache, cacheKey, resultado);
        }
        return resultado;
    } catch (error) {
        logError(`calcularMedianaHistoricaMes(${mesStr})`, error);
        return { mediana: 0, promedio: 0, aniosAnalizados: 0 };
    }
}

// ---------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------
app.get('/', (req, res) => {
    try {
        res.json({
            status: 'ok',
            servicio: 'API de Incendios NASA FIRMS + GCS (MODIS + VIIRS)',
            endpoints: ['/api/incendios', '/api/incendios/resumen', '/api/incendios/historial-anual', '/api/paises', '/api/health']
        });
    } catch (error) {
        logError('GET /', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/health', (req, res) => {
    try {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (error) {
        logError('GET /api/health', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/paises', async (req, res) => {
    try {
        const { porCodigo } = await cargarPaisesFirms();
        const vistos = new Map();
        for (const item of porCodigo.values()) {
            if (!item || !item.codigo || vistos.has(item.codigo)) continue;
            vistos.set(item.codigo, {
                codigo: item.codigo,
                iso2: item.iso2 || '',
                nombre: item.nameEn || item.nombre,
                nombreGcs: item.nombre
            });
        }
        const paises = Array.from(vistos.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return await enviarJson(req, res, { total: paises.length, paises });
    } catch (error) {
        logError('GET /api/paises', error);
        res.status(500).json({ error: 'No se pudo cargar el catálogo de países' });
    }
});

function construirResumenDiarioPayload({ anioNum, anioStr, mesNum, mesStr, datosMesSeleccionado }) {
    const totalDias = diasEnMes(anioNum, mesNum);
    const diasObj = datosMesSeleccionado.dias || {};
    const resumenDiario = [];
    let diaPico = null;

    for (let d = 1; d <= totalDias; d++) {
        const diaStr = String(d).padStart(2, '0');
        const fechaDia = `${anioStr}-${mesStr}-${diaStr}`;
        const info = diasObj[d] || { totalFocos: 0, frpMax: 0, nivelMax: 0 };
        const frpMaxDia = info.totalFocos > 0 ? Math.round(info.frpMax * 100) / 100 : 0;

        resumenDiario.push({
            dia: d,
            fecha: fechaDia,
            totalFocos: info.totalFocos,
            frpMax: frpMaxDia,
            intensidadMaxima: info.totalFocos > 0 ? nombreIntensidad(info.nivelMax) : 'Sin datos',
            nivelMaximo: info.totalFocos > 0 ? info.nivelMax : 0
        });

        if (info.totalFocos > 0 && (!diaPico || info.totalFocos > diaPico.totalFocos)) {
            diaPico = { dia: d, totalFocos: info.totalFocos };
        }
    }

    return {
        resumenDiario,
        diaPico: diaPico || { dia: 1, totalFocos: 0 },
        intensidadMaximaMes: datosMesSeleccionado.intensidadMaxima,
        nivelMaximoMes: datosMesSeleccionado.nivelMaximo,
        distribucionIntensidad: datosMesSeleccionado.distribucion
    };
}

app.get('/api/incendios/resumen', async (req, res) => {
    try {
        const { anioConsulta, mesConsulta, pais, modo } = req.query;
        const { bbox, error: errEspacial } = parsearFiltrosEspaciales(req.query);
        if (errEspacial) {
            return res.status(400).json({ error: errEspacial });
        }

        const anioNum = parseInt(anioConsulta, 10);
        const maxAnio = new Date().getUTCFullYear() + 1;
        const esModoRapido = String(modo || '').toLowerCase() === 'rapido';

        if (!anioConsulta || !/^\d{4}$/.test(String(anioConsulta)) || anioNum < ANIO_MINIMO_GCS || anioNum > maxAnio) {
            return res.status(400).json({
                error: `El parámetro "anioConsulta" es obligatorio y debe ser un año válido (${ANIO_MINIMO_GCS}–${maxAnio}).`
            });
        }

        let mesNum = null;
        let mesStr = null;
        if (mesConsulta !== undefined && mesConsulta !== '') {
            mesNum = parseInt(mesConsulta, 10);
            if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
                return res.status(400).json({
                    error: 'El parámetro "mesConsulta" debe estar entre 1 y 12.'
                });
            }
            mesStr = String(mesNum).padStart(2, '0');
        }

        const anioStr = String(anioNum);
        const fechaHoy = obtenerFechaHoy();
        const [hoyAnioStr, hoyMesStr] = fechaHoy.split('-');
        const hoyAnioNum = parseInt(hoyAnioStr, 10);
        const paisFiltro = pais || null;
        const areaKey = construirClaveArea({ paisFiltro, bbox });
        const paisesBbox = !paisFiltro && bbox ? await resolverPaisesPorBbox(bbox) : null;
        const esAnioPasadoGlobal = anioNum < hoyAnioNum && !paisFiltro && !bbox;
        const etiquetaArea = paisFiltro || (bbox ? 'Área seleccionada' : 'Global');

        // 1. Camino ultrarrápido: revisar si el año completo ya existe precalculado en GCS (_iris_cache/resumen_YYYY.json)
        let anioDesdeCacheGcs = null;
        if (esAnioPasadoGlobal) {
            const todosMesesEnRam = Array.from({ length: 12 }, (_, idx) => {
                const mStr = String(idx + 1).padStart(2, '0');
                return getCached(resumenMesCache, `${anioStr}-${mStr}:global`, 6 * 60 * 60 * 1000);
            });
            const ramCompleta = todosMesesEnRam.every((m) => m && m.dias !== undefined && m.dias !== null);
            if (ramCompleta) {
                anioDesdeCacheGcs = { meses: todosMesesEnRam };
            } else {
                anioDesdeCacheGcs = await cargarResumenAnioDesdeGcs(anioStr);
            }
        }

        if (anioDesdeCacheGcs) {
            const resumenMensual = anioDesdeCacheGcs.meses.map((m) => ({
                mes: m.mes,
                totalFocos: m.totalFocos,
                frpMax: m.frpMax,
                frpAvg: m.frpAvg || 0,
                intensidadMaxima: m.intensidadMaxima,
                nivelMaximo: m.nivelMaximo
            }));
            const payload = {
                anio: anioNum,
                mes: mesNum,
                pais: etiquetaArea,
                bbox: null,
                parcial: false,
                resumenMensual
            };
            if (mesNum !== null) {
                const datosMes = anioDesdeCacheGcs.meses[mesNum - 1];
                Object.assign(payload, construirResumenDiarioPayload({
                    anioNum, anioStr, mesNum, mesStr, datosMesSeleccionado: datosMes
                }));
                const medianaInfo = await calcularMedianaHistoricaMes({
                    mesStr,
                    paisFiltro,
                    bbox,
                    paisesBbox,
                    anioActualMax: hoyAnioNum,
                    mesActualDatos: { anio: anioNum, totalFocos: datosMes.totalFocos }
                });
                payload.medianaHistoricaMes = medianaInfo.mediana;
                payload.promedioHistoricoMes = medianaInfo.promedio || 0;
                payload.aniosDisponiblesMediana = medianaInfo.aniosAnalizados;
            }
            return await enviarJson(req, res, payload);
        }

        // 2. Camino rápido en primera carga fría (devuelve solo el mes solicitado sin bloquear por los otros 11 meses ni mediana)
        if (esModoRapido && mesNum !== null) {
            const archivosMes = await listarArchivosMes(anioStr, mesStr);
            const datosMesSeleccionado = await calcularResumenMes({
                anioStr,
                mesStr,
                archivosMes,
                paisFiltro,
                bbox,
                paisesBbox,
                incluirDias: true,
                fechaHoy
            });
            const resumenMensual = Array.from({ length: 12 }, (_, idx) => {
                const m = idx + 1;
                if (m === mesNum) {
                    return {
                        mes: m,
                        totalFocos: datosMesSeleccionado.totalFocos,
                        frpMax: datosMesSeleccionado.frpMax,
                        frpAvg: datosMesSeleccionado.frpAvg || 0,
                        intensidadMaxima: datosMesSeleccionado.intensidadMaxima,
                        nivelMaximo: datosMesSeleccionado.nivelMaximo
                    };
                }
                const mStr = String(m).padStart(2, '0');
                const cachedOther = getCached(resumenMesCache, `${anioStr}-${mStr}:${areaKey}`, 6 * 60 * 60 * 1000);
                if (cachedOther) {
                    return {
                        mes: m,
                        totalFocos: cachedOther.totalFocos,
                        frpMax: cachedOther.frpMax,
                        frpAvg: cachedOther.frpAvg || 0,
                        intensidadMaxima: cachedOther.intensidadMaxima,
                        nivelMaximo: cachedOther.nivelMaximo
                    };
                }
                return { mes: m, totalFocos: 0, frpMax: 0, frpAvg: 0, intensidadMaxima: 'Sin datos', nivelMaximo: 0 };
            });

            const payload = {
                anio: anioNum,
                mes: mesNum,
                pais: etiquetaArea,
                bbox: bbox || null,
                parcial: true,
                resumenMensual,
                ...construirResumenDiarioPayload({
                    anioNum, anioStr, mesNum, mesStr, datosMesSeleccionado
                })
            };
            return await enviarJson(req, res, payload);
        }

        // 3. Camino completo con single-flight por año/área y persistencia en GCS
        const resumenKey = `${anioStr}:${areaKey}`;
        let promesaAnio = resumenAnioPromesas.get(resumenKey);
        if (!promesaAnio) {
            promesaAnio = (async () => {
                const archivosPorMes = await listarArchivosAnioPorMes(anioStr);
                const resumenMensual = new Array(12);
                const mesesCompletos = new Array(12);

                const ordenMeses = [];
                if (mesNum !== null) ordenMeses.push(mesNum);
                for (let m = 1; m <= 12; m++) {
                    if (m !== mesNum) ordenMeses.push(m);
                }

                if (mesNum !== null) {
                    const primero = await calcularResumenMes({
                        anioStr,
                        mesStr,
                        archivosMes: archivosPorMes[mesNum - 1],
                        paisFiltro,
                        bbox,
                        paisesBbox,
                        incluirDias: true,
                        fechaHoy
                    });
                    mesesCompletos[mesNum - 1] = primero;
                    resumenMensual[mesNum - 1] = {
                        mes: mesNum,
                        totalFocos: primero.totalFocos,
                        frpMax: primero.frpMax,
                        frpAvg: primero.frpAvg || 0,
                        intensidadMaxima: primero.intensidadMaxima,
                        nivelMaximo: primero.nivelMaximo
                    };
                }

                const mesesPendientes = ordenMeses.filter((m) => m !== mesNum);
                await conLimite(mesesPendientes, 4, async (m) => {
                    const mStr = String(m).padStart(2, '0');
                    const esMesActual = anioStr === hoyAnioStr && mStr === hoyMesStr;
                    if (archivosPorMes[m - 1].length === 0 && !esMesActual) {
                        const vacio = {
                            mes: m,
                            totalFocos: 0,
                            frpMax: 0,
                            frpAvg: 0,
                            intensidadMaxima: 'Sin datos',
                            nivelMaximo: 0,
                            distribucion: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
                            dias: {}
                        };
                        mesesCompletos[m - 1] = vacio;
                        resumenMensual[m - 1] = {
                            mes: m,
                            totalFocos: 0,
                            frpMax: 0,
                            frpAvg: 0,
                            intensidadMaxima: 'Sin datos',
                            nivelMaximo: 0
                        };
                        if (!paisFiltro && !bbox && anioNum < hoyAnioNum) {
                            setCached(resumenMesCache, `${anioStr}-${mStr}:global`, vacio);
                        }
                        return;
                    }
                    const r = await calcularResumenMes({
                        anioStr,
                        mesStr: mStr,
                        archivosMes: archivosPorMes[m - 1],
                        paisFiltro,
                        bbox,
                        paisesBbox,
                        incluirDias: true,
                        fechaHoy
                    });
                    mesesCompletos[m - 1] = r;
                    resumenMensual[m - 1] = {
                        mes: r.mes,
                        totalFocos: r.totalFocos,
                        frpMax: r.frpMax,
                        frpAvg: r.frpAvg || 0,
                        intensidadMaxima: r.intensidadMaxima,
                        nivelMaximo: r.nivelMaximo
                    };
                });

                // Persiste el año completo en GCS (_iris_cache/resumen_YYYY.json) si es histórico global
                if (esAnioPasadoGlobal && mesesCompletos.every(Boolean)) {
                    guardarEnGcsSegundoPlano(`${GCS_CACHE_PREFIX}/resumen_${anioStr}.json`, JSON.stringify({
                        schemaVersion: CACHE_SCHEMA_VERSION,
                        anio: anioNum,
                        meses: mesesCompletos
                    }));
                }

                return { mesesCompletos, resumenMensual };
            })().finally(() => {
                resumenAnioPromesas.delete(resumenKey);
            });
            resumenAnioPromesas.set(resumenKey, promesaAnio);
        }

        const { mesesCompletos, resumenMensual } = await promesaAnio;
        const datosMesSeleccionado = mesNum !== null ? mesesCompletos[mesNum - 1] : null;

        const payload = {
            anio: anioNum,
            mes: mesNum,
            pais: etiquetaArea,
            bbox: bbox || null,
            parcial: false,
            resumenMensual
        };

        if (mesNum !== null && datosMesSeleccionado) {
            Object.assign(payload, construirResumenDiarioPayload({
                anioNum, anioStr, mesNum, mesStr, datosMesSeleccionado
            }));

            const medianaInfo = await calcularMedianaHistoricaMes({
                mesStr,
                paisFiltro,
                bbox,
                paisesBbox,
                anioActualMax: hoyAnioNum,
                mesActualDatos: { anio: anioNum, totalFocos: datosMesSeleccionado.totalFocos }
            });

            payload.medianaHistoricaMes = medianaInfo.mediana;
            payload.promedioHistoricoMes = medianaInfo.promedio || 0;
            payload.aniosDisponiblesMediana = medianaInfo.aniosAnalizados;
        }

        return await enviarJson(req, res, payload);
    } catch (error) {
        logError('/api/incendios/resumen', error);
        res.status(500).json({ error: 'Error interno al generar resumen histórico', detalle: error.message });
    }
});

// ---------------------------------------------------------------
// HISTORIAL ANUAL Y ESTACIONAL (2000–PRESENTE) POR ÁREA O GLOBAL
// ---------------------------------------------------------------
function crearRegistroAnioVacio(anio) {
    return {
        anio,
        totalFocos: 0,
        frpMax: 0,
        frpAvg: 0,
        _sumFrp: 0,
        _validFrp: 0,
        nivelMaximo: 0,
        mesPico: 0,
        mesPicoFocos: 0,
        meses: new Array(12).fill(0)
    };
}

function finalizarListaAnios(aniosMap, desdeAnio, hastaAnio, areaLabel, bbox, parcial) {
    const porAnio = [];
    const mesBuckets = Array.from({ length: 12 }, (_, idx) => ({
        mes: idx + 1,
        totalFocos: 0,
        valoresConDatos: [],
        maxAnual: 0,
        anioPico: 0
    }));

    for (let y = desdeAnio; y <= hastaAnio; y++) {
        const reg = aniosMap.get(y) || crearRegistroAnioVacio(y);
        let sumMes = 0;
        let mesPico = 0;
        let mesPicoFocos = 0;
        const mesesLimpios = reg.meses.map((v, idx) => {
            const c = Math.max(0, Math.round(Number(v) || 0));
            sumMes += c;
            if (c > mesPicoFocos) {
                mesPicoFocos = c;
                mesPico = idx + 1;
            }
            const mb = mesBuckets[idx];
            mb.totalFocos += c;
            if (c > 0) {
                mb.valoresConDatos.push(c);
                if (c > mb.maxAnual) {
                    mb.maxAnual = c;
                    mb.anioPico = y;
                }
            }
            return c;
        });

        const totalFocos = Math.max(reg.totalFocos || 0, sumMes);
        const frpMax = totalFocos > 0 ? Math.round((reg.frpMax || 0) * 100) / 100 : 0;
        const frpAvg = reg._validFrp > 0
            ? Math.round((reg._sumFrp / reg._validFrp) * 100) / 100
            : (reg.frpAvg || 0);
        const nivelMaximo = reg.nivelMaximo || (totalFocos > 0 && frpMax > 0 ? clasificarNivelFrp(frpMax) : 0);

        porAnio.push({
            anio: y,
            totalFocos,
            frpMax,
            frpAvg,
            nivelMaximo,
            mesPico,
            mesPicoFocos,
            meses: mesesLimpios
        });
    }

    const completosPasados = porAnio.filter((y) => y.anio < hastaAnio && y.totalFocos > 0);
    const baseAnual = completosPasados.length > 0 ? completosPasados : porAnio.filter((y) => y.totalFocos > 0);
    const totalHistorico = porAnio.reduce((acc, y) => acc + y.totalFocos, 0);
    const valoresAnuales = baseAnual.map((y) => y.totalFocos);
    const promedioAnual = calcularPromedio(valoresAnuales);
    const medianaAnual = calcularMediana(valoresAnuales);

    const topAnios = porAnio
        .filter((y) => y.totalFocos > 0)
        .slice()
        .sort((a, b) => b.totalFocos - a.totalFocos)
        .slice(0, 6)
        .map(({ anio, totalFocos, frpMax, frpAvg, mesPico, mesPicoFocos }) => ({
            anio, totalFocos, frpMax, frpAvg, mesPico, mesPicoFocos
        }));

    const porMes = mesBuckets.map((mb) => {
        // Divide promedio entre años que realmente tuvieron cobertura en el dataset para evitar sesgo por meses sin registro
        const aniosActivosArea = baseAnual.length || 1;
        const promedioMes = Math.round((mb.totalFocos / aniosActivosArea) * 100) / 100;
        return {
            mes: mb.mes,
            totalFocos: mb.totalFocos,
            aniosConDatos: mb.valoresConDatos.length,
            promedioAnual: mb.valoresConDatos.length > 0 ? calcularPromedio(mb.valoresConDatos) : promedioMes,
            medianaAnual: calcularMediana(mb.valoresConDatos),
            maxAnual: mb.maxAnual,
            anioPico: mb.anioPico
        };
    });

    const mesCounts = porMes.filter((m) => m.totalFocos > 0).map((m) => m.aniosConDatos);
    const maxMesAnios = mesCounts.length ? Math.max(...mesCounts) : 0;
    const minMesAnios = mesCounts.length ? Math.min(...mesCounts) : 0;
    const coberturaDesigual = Boolean(parcial) || (maxMesAnios - minMesAnios > 3);
    const topMesesEstacionales = porMes
        .filter((m) => m.totalFocos > 0)
        .slice()
        .sort((a, b) => coberturaDesigual
            ? (b.totalFocos - a.totalFocos)
            : (b.promedioAnual - a.promedioAnual))
        .slice(0, 4);

    return {
        desdeAnio,
        hastaAnio,
        pais: areaLabel,
        bbox: bbox || null,
        parcial: Boolean(parcial),
        totalHistorico,
        aniosConDatos: porAnio.filter((y) => y.totalFocos > 0).length,
        promedioAnual,
        medianaAnual,
        anioPico: topAnios[0] || null,
        topAnios,
        mesPicoEstacional: topMesesEstacionales[0] || null,
        topMesesEstacionales,
        porAnio,
        porMes
    };
}

app.get('/api/incendios/historial-anual', async (req, res) => {
    try {
        const { pais } = req.query;
        const { bbox, error: errEspacial } = parsearFiltrosEspaciales(req.query);
        if (errEspacial) {
            return res.status(400).json({ error: errEspacial });
        }

        const fechaHoy = obtenerFechaHoy();
        const [hoyAnioStr, hoyMesStr] = fechaHoy.split('-');
        const hoyAnioNum = parseInt(hoyAnioStr, 10);
        const hoyMesNum = parseInt(hoyMesStr, 10);
        const paisFiltro = pais || null;
        const esGlobalPuro = !paisFiltro && !bbox;
        const areaKey = construirClaveArea({ paisFiltro, bbox });
        const cacheKey = `${areaKey}:${fechaHoy}`;
        const etiquetaArea = paisFiltro || (bbox ? 'Área seleccionada' : 'Global');

        const cached = getCached(historialAnualCache, cacheKey, 30 * 60 * 1000);
        if (cached) {
            return await enviarJson(req, res, cached);
        }

        let promesa = historialAnualPromesas.get(cacheKey);
        if (!promesa) {
            promesa = (async () => {
                const aniosMap = new Map();
                for (let y = ANIO_MINIMO_GCS; y <= hoyAnioNum; y++) {
                    aniosMap.set(y, crearRegistroAnioVacio(y));
                }

                const aniosPasados = [];
                for (let y = ANIO_MINIMO_GCS; y < hoyAnioNum; y++) aniosPasados.push(y);

                const paisesBbox = !paisFiltro && bbox ? await resolverPaisesPorBbox(bbox) : null;
                const gcsHistKey = esGlobalPuro
                    ? `${GCS_CACHE_PREFIX}/historial_global_pasado_v1.json`
                    : `${GCS_CACHE_PREFIX}/hist_area_${crypto.createHash('sha1').update(areaKey).digest('hex').slice(0, 16)}_v1.json`;

                let pasadosDesdeGcs = false;
                let parcialPasado = false;

                try {
                    const docPast = await leerJsonGcs(gcsHistKey);
                    if (
                        docPast &&
                        docPast.schemaVersion === CACHE_SCHEMA_VERSION &&
                        docPast.areaKey === areaKey &&
                        docPast.hastaAnioPasado >= hoyAnioNum - 1 &&
                        Array.isArray(docPast.porAnio)
                    ) {
                        for (const item of docPast.porAnio) {
                            if (!item || !aniosMap.has(item.anio)) continue;
                            aniosMap.set(item.anio, {
                                anio: item.anio,
                                totalFocos: item.totalFocos || 0,
                                frpMax: item.frpMax || 0,
                                frpAvg: item.frpAvg || 0,
                                _sumFrp: 0,
                                _validFrp: 0,
                                nivelMaximo: item.nivelMaximo || 0,
                                mesPico: item.mesPico || 0,
                                mesPicoFocos: item.mesPicoFocos || 0,
                                meses: Array.isArray(item.meses) && item.meses.length === 12
                                    ? item.meses.slice()
                                    : new Array(12).fill(0)
                            });
                        }
                        pasadosDesdeGcs = true;
                    }
                } catch {
                    // continúa con cálculo
                }

                let bgPendientesGlobal = null;
                let bgEscanearAnioGlobal = null;
                if (!pasadosDesdeGcs) {
                    const inicioPasado = Date.now();
                    const PRESUPUESTO_HIST_MS = esGlobalPuro ? 14000 : 24000;

                    if (esGlobalPuro) {
                        // 1. Aprovecha resúmenes anuales o conteos globales ya guardados en GCS
                        const faltantes = new Set(aniosPasados);
                        await conLimite(aniosPasados, 12, async (y) => {
                            const doc = await cargarResumenAnioDesdeGcs(String(y));
                            if (doc && Array.isArray(doc.meses) && doc.meses.length === 12) {
                                const reg = aniosMap.get(y);
                                let frpMax = 0;
                                let nivelMax = 0;
                                let total = 0;
                                for (let i = 0; i < 12; i++) {
                                    const m = doc.meses[i] || {};
                                    const c = Number(m.totalFocos) || 0;
                                    reg.meses[i] = c;
                                    total += c;
                                    if (Number(m.frpMax) > frpMax) frpMax = Number(m.frpMax);
                                    if (Number(m.nivelMaximo) > nivelMax) nivelMax = Number(m.nivelMaximo);
                                }
                                reg.totalFocos = total;
                                reg.frpMax = frpMax;
                                reg.nivelMaximo = nivelMax;
                                faltantes.delete(y);
                                return;
                            }
                            const docY = await leerJsonGcs(`${GCS_CACHE_PREFIX}/hist_global_y_${y}.json`);
                            if (docY && docY.schemaVersion === CACHE_SCHEMA_VERSION && Array.isArray(docY.meses) && docY.meses.length === 12) {
                                const reg = aniosMap.get(y);
                                reg.meses = docY.meses.map((v) => Math.max(0, Number(v) || 0));
                                reg.totalFocos = reg.meses.reduce((a, b) => a + b, 0);
                                reg.frpMax = Number(docY.frpMax) || 0;
                                reg.nivelMaximo = Number(docY.nivelMaximo) || 0;
                                faltantes.delete(y);
                            }
                        });

                        // 2. Para los años que aún no tenían cache, aprovecha _iris_cache/mediana_MM.json
                        if (faltantes.size > 0) {
                            const mesesFaltantesPorAnio = new Map();
                            for (const y of faltantes) {
                                mesesFaltantesPorAnio.set(y, new Set(Array.from({ length: 12 }, (_, i) => i + 1)));
                            }
                            await conLimite(Array.from({ length: 12 }, (_, i) => i + 1), 12, async (m) => {
                                const mStr = String(m).padStart(2, '0');
                                const docMed = await leerJsonGcs(`${GCS_CACHE_PREFIX}/mediana_${mStr}.json`);
                                if (docMed && docMed.schemaVersion === CACHE_SCHEMA_VERSION && docMed.porAnio) {
                                    for (const y of faltantes) {
                                        if (docMed.porAnio[String(y)] !== undefined) {
                                            const c = Number(docMed.porAnio[String(y)]) || 0;
                                            aniosMap.get(y).meses[m - 1] = c;
                                            mesesFaltantesPorAnio.get(y).delete(m);
                                        }
                                    }
                                }
                            });

                            const pendientesScan = [];
                            for (const y of Array.from(mesesFaltantesPorAnio.keys()).sort((a, b) => b - a)) {
                                const mSet = mesesFaltantesPorAnio.get(y);
                                if (mSet && mSet.size > 0) pendientesScan.push([y, Array.from(mSet)]);
                            }

                            const escanearAnioGlobal = async ([y, mesesFalt], conPresupuesto) => {
                                if (conPresupuesto && Date.now() - inicioPasado > PRESUPUESTO_HIST_MS) {
                                    parcialPasado = true;
                                    return false;
                                }
                                const archivosPorMes = await listarArchivosAnioPorMes(String(y));
                                const reg = aniosMap.get(y);
                                let anioParcial = false;
                                await conLimite(mesesFalt, 4, async (m) => {
                                    if (conPresupuesto && Date.now() - inicioPasado > PRESUPUESTO_HIST_MS) {
                                        anioParcial = true;
                                        parcialPasado = true;
                                        return;
                                    }
                                    let totalM = 0;
                                    let mesParcial = false;
                                    await conLimite(ordenarPorTamanoDesc(archivosPorMes[m - 1] || []), 20, async (a) => {
                                        if (conPresupuesto && Date.now() - inicioPasado > PRESUPUESTO_HIST_MS) {
                                            mesParcial = true;
                                            anioParcial = true;
                                            parcialPasado = true;
                                            return;
                                        }
                                        totalM += await contarFilasCsvGcs(a.file);
                                    });
                                    if (!mesParcial) {
                                        reg.meses[m - 1] = totalM;
                                    }
                                });
                                reg.totalFocos = reg.meses.reduce((a, b) => a + b, 0);
                                if (!anioParcial) {
                                    guardarEnGcsSegundoPlano(`${GCS_CACHE_PREFIX}/hist_global_y_${y}.json`, JSON.stringify({
                                        schemaVersion: CACHE_SCHEMA_VERSION,
                                        anio: y,
                                        meses: reg.meses,
                                        frpMax: reg.frpMax || 0,
                                        nivelMaximo: reg.nivelMaximo || 0,
                                        totalFocos: reg.totalFocos
                                    }));
                                }
                                return !anioParcial;
                            };

                            // Escanea años recientes faltantes dentro del presupuesto y guarda cada año completo en GCS
                            const completadosFg = new Set();
                            await conLimite(pendientesScan, 2, async (item) => {
                                const ok = await escanearAnioGlobal(item, true);
                                if (ok) completadosFg.add(item[0]);
                            });

                            for (const y of faltantes) {
                                const reg = aniosMap.get(y);
                                reg.totalFocos = reg.meses.reduce((a, b) => a + b, 0);
                            }

                            if (parcialPasado && pendientesScan.length > 0 && !precalentandoGlobalPromesa) {
                                const restantesScan = pendientesScan.filter(([y]) => !completadosFg.has(y));
                                if (restantesScan.length > 0) {
                                    bgPendientesGlobal = restantesScan;
                                    bgEscanearAnioGlobal = escanearAnioGlobal;
                                }
                            }
                        }
                    } else {
                        // Área específica (país y/o bbox): lista y escanea archivos por año (más recientes primero)
                        const aniosDesc = aniosPasados.slice().reverse();
                        await conLimite(aniosDesc, 2, async (y) => {
                            if (Date.now() - inicioPasado > PRESUPUESTO_HIST_MS) {
                                parcialPasado = true;
                                return;
                            }
                            const archivosPorMes = await listarArchivosAnioPorMes(String(y));
                            const reg = aniosMap.get(y);
                            await conLimite(Array.from({ length: 12 }, (_, idx) => idx + 1), 6, async (m) => {
                                if (Date.now() - inicioPasado > PRESUPUESTO_HIST_MS) {
                                    parcialPasado = true;
                                    return;
                                }
                                const archivosMes = archivosPorMes[m - 1] || [];
                                const objetivo = await seleccionarArchivosPorArea(archivosMes, paisFiltro, bbox, paisesBbox);
                                if (!objetivo.length) return;

                                let totalM = 0;
                                let frpMaxM = 0;
                                let sumFrpM = 0;
                                let validFrpM = 0;
                                await conLimite(ordenarPorTamanoDesc(objetivo), 8, async (a) => {
                                    await escanearCsvResumenConCoordsGcs(a.file, bbox, (_fechaStr, frpRaw) => {
                                        totalM++;
                                        const frp = parseFloat(frpRaw);
                                        if (Number.isFinite(frp)) {
                                            if (frp > frpMaxM) frpMaxM = frp;
                                            sumFrpM += frp;
                                            validFrpM++;
                                        }
                                    });
                                });

                                reg.meses[m - 1] = totalM;
                                reg.totalFocos += totalM;
                                reg._sumFrp += sumFrpM;
                                reg._validFrp += validFrpM;
                                if (frpMaxM > reg.frpMax) reg.frpMax = frpMaxM;
                            });
                            if (reg.totalFocos > 0 && reg.frpMax > 0) {
                                reg.nivelMaximo = clasificarNivelFrp(reg.frpMax);
                            }
                        });
                    }

                    if (!parcialPasado) {
                        const resumenPasadoSnapshot = aniosPasados.map((y) => {
                            const r = aniosMap.get(y);
                            const avg = r._validFrp > 0 ? Math.round((r._sumFrp / r._validFrp) * 100) / 100 : (r.frpAvg || 0);
                            return {
                                anio: r.anio,
                                totalFocos: r.totalFocos,
                                frpMax: Math.round((r.frpMax || 0) * 100) / 100,
                                frpAvg: avg,
                                nivelMaximo: r.nivelMaximo,
                                meses: r.meses
                            };
                        });
                        guardarEnGcsSegundoPlano(gcsHistKey, JSON.stringify({
                            schemaVersion: CACHE_SCHEMA_VERSION,
                            areaKey,
                            hastaAnioPasado: hoyAnioNum - 1,
                            porAnio: resumenPasadoSnapshot
                        }));
                    }
                }

                // 3. Incorpora siempre el año en curso (2026 u hoyAnioNum) hasta el mes actual con datos en vivo
                const regActual = aniosMap.get(hoyAnioNum);
                const archivosAnioActual = await listarArchivosAnioPorMes(hoyAnioStr).catch(() => Array.from({ length: 12 }, () => []));
                await conLimite(Array.from({ length: hoyMesNum }, (_, i) => i + 1), 4, async (m) => {
                    const mStr = String(m).padStart(2, '0');
                    const mesObj = await calcularResumenMes({
                        anioStr: hoyAnioStr,
                        mesStr: mStr,
                        archivosMes: archivosAnioActual[m - 1] || [],
                        paisFiltro,
                        bbox,
                        paisesBbox,
                        incluirDias: false,
                        fechaHoy
                    });
                    regActual.meses[m - 1] = mesObj.totalFocos;
                    regActual.totalFocos += mesObj.totalFocos;
                    if (mesObj.frpMax > regActual.frpMax) regActual.frpMax = mesObj.frpMax;
                    if (mesObj.nivelMaximo > regActual.nivelMaximo) regActual.nivelMaximo = mesObj.nivelMaximo;
                    if (mesObj.frpAvg > 0 && mesObj.totalFocos > 0) {
                        regActual._sumFrp += mesObj.frpAvg * mesObj.totalFocos;
                        regActual._validFrp += mesObj.totalFocos;
                    }
                });

                const payload = finalizarListaAnios(aniosMap, ANIO_MINIMO_GCS, hoyAnioNum, etiquetaArea, bbox, parcialPasado);
                if (!parcialPasado) {
                    setCached(historialAnualCache, cacheKey, payload);
                } else if (bgPendientesGlobal && bgEscanearAnioGlobal && !precalentandoGlobalPromesa) {
                    precalentandoGlobalPromesa = (async () => {
                        try {
                            await conLimite(bgPendientesGlobal, 2, (item) => bgEscanearAnioGlobal(item, false));
                            const snapshotGlobal = aniosPasados.map((y) => {
                                const r = aniosMap.get(y);
                                return {
                                    anio: r.anio,
                                    totalFocos: r.totalFocos,
                                    frpMax: Math.round((r.frpMax || 0) * 100) / 100,
                                    frpAvg: r.frpAvg || 0,
                                    nivelMaximo: r.nivelMaximo,
                                    meses: r.meses
                                };
                            });
                            guardarEnGcsSegundoPlano(gcsHistKey, JSON.stringify({
                                schemaVersion: CACHE_SCHEMA_VERSION,
                                areaKey,
                                hastaAnioPasado: hoyAnioNum - 1,
                                porAnio: snapshotGlobal
                            }));
                            const completo = finalizarListaAnios(aniosMap, ANIO_MINIMO_GCS, hoyAnioNum, etiquetaArea, bbox, false);
                            setCached(historialAnualCache, cacheKey, completo);
                        } catch (bgErr) {
                            logWarn(`Precalentamiento global de historial interrumpido: ${bgErr.message}`);
                        } finally {
                            precalentandoGlobalPromesa = null;
                        }
                    })();
                }
                return payload;
            })().finally(() => {
                historialAnualPromesas.delete(cacheKey);
            });
            historialAnualPromesas.set(cacheKey, promesa);
        }

        const resultado = await promesa;
        return await enviarJson(req, res, resultado);
    } catch (error) {
        logError('/api/incendios/historial-anual', error);
        res.status(500).json({ error: 'Error interno al generar historial anual de incendios', detalle: error.message });
    }
});

app.get('/api/incendios', async (req, res) => {
    try {
        log('INFO', 'Parámetros recibidos:', JSON.stringify(req.query));
        const { fecha, mesConsulta, anioConsulta, pais, horaInicio, horaFin, formato, compact } = req.query;
        const esCompacto = String(compact || '') === '1';
        const limite = Math.max(1, parseInt(req.query.limite, 10) || LIMITE_POR_DEFECTO);
        const fechaHoy = obtenerFechaHoy();
        const fechaAyer = obtenerFechaAyer();

        const { bbox, radio, error: errEspacial } = parsearFiltrosEspaciales(req.query);
        if (errEspacial) {
            return res.status(400).json({ error: errEspacial });
        }

        let anio, mes;
        if (fecha) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
                return res.status(400).json({ error: 'El parámetro "fecha" debe tener formato YYYY-MM-DD.' });
            }
            [anio, mes] = fecha.split('-');
        } else if (mesConsulta && anioConsulta) {
            anio = String(anioConsulta);
            mes = String(mesConsulta).padStart(2, '0');
        } else {
            return res.status(400).json({
                error: 'Debes proporcionar "fecha" (YYYY-MM-DD) o "mesConsulta" y "anioConsulta".'
            });
        }

        const esHoy = fecha === fechaHoy;
        const esReciente48h = fecha === fechaHoy || fecha === fechaAyer;
        const esMesActual = `${anio}-${mes}` === fechaHoy.slice(0, 7);
        const requiereDatosFrescos = esHoy || (!fecha && esMesActual);
        const sinFiltrosExtra = !bbox && !radio && !horaInicio && !horaFin && String(formato || '').toLowerCase() !== 'csv';

        // -----------------------------------------------------------
        // RUTA ULTRARRÁPIDA PARA MESES Y DÍAS HISTÓRICOS GLOBALES
        // -----------------------------------------------------------
        if (!pais && !esMesActual && !esReciente48h) {
            if (fecha && sinFiltrosExtra && limite >= LIMITE_POR_DEFECTO) {
                const ramKey = `day:${fecha}:${limite}`;
                const ramHit = getRamGzCache(ramKey);
                if (ramHit) {
                    if (esCompacto) {
                        log('INFO', `Caché RAM hit: ${fecha}`);
                        return await enviarBufferJsonGzip(req, res, ramHit);
                    }
                    const parsed = JSON.parse((await gunzipAsync(ramHit)).toString('utf8'));
                    return await enviarJson(req, res, construirPayloadApiIncendios({
                        esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                        paisesLeidos: parsed.paisesIncluidos, totalRegistros: parsed.totalRegistros,
                        rowsCompact: null, dataObjetos: compactARegistrosObjeto(parsed.rows), truncado: parsed.truncado
                    }));
                }
            } else if (!fecha && sinFiltrosExtra && limite <= LIMITE_POR_DEFECTO) {
                const ramKey = `preview:${anio}-${mes}:${limite}`;
                const ramHit = getRamGzCache(ramKey);
                if (ramHit) {
                    if (esCompacto) {
                        log('INFO', `Caché RAM hit: ${anio}-${mes} preview`);
                        return await enviarBufferJsonGzip(req, res, ramHit);
                    }
                    const parsed = JSON.parse((await gunzipAsync(ramHit)).toString('utf8'));
                    return await enviarJson(req, res, construirPayloadApiIncendios({
                        esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                        paisesLeidos: parsed.paisesIncluidos, totalRegistros: parsed.totalRegistros,
                        rowsCompact: null, dataObjetos: compactARegistrosObjeto(parsed.rows), truncado: parsed.truncado
                    }));
                }
            }

            // Revisa índice local en /tmp primero; si no existe, revisa caché single-blob en GCS antes de descargar 190+ CSVs
            let localHit = await leerMetaMesLocal(anio, mes);
            if (!localHit && fecha && sinFiltrosExtra && limite >= LIMITE_POR_DEFECTO) {
                const gcsDayKey = `${GCS_CACHE_PREFIX}/days/${fecha}_${limite}.compact.json.gz`;
                const gcsGz = await leerArchivoGcsBuffer(gcsDayKey);
                if (gcsGz) {
                    log('INFO', `Caché GCS hit: ${gcsDayKey} (${(gcsGz.length / 1024).toFixed(0)} KB)`);
                    const ramKey = `day:${fecha}:${limite}`;
                    setRamGzCache(ramKey, gcsGz);
                    if (esCompacto) return await enviarBufferJsonGzip(req, res, gcsGz);
                    const parsed = JSON.parse((await gunzipAsync(gcsGz)).toString('utf8'));
                    return await enviarJson(req, res, construirPayloadApiIncendios({
                        esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                        paisesLeidos: parsed.paisesIncluidos, totalRegistros: parsed.totalRegistros,
                        rowsCompact: null, dataObjetos: compactARegistrosObjeto(parsed.rows), truncado: parsed.truncado
                    }));
                }
            } else if (!localHit && !fecha && sinFiltrosExtra && limite <= LIMITE_POR_DEFECTO) {
                const gcsPrevKey = `${GCS_CACHE_PREFIX}/months/${anio}_${mes}_preview_${limite}.compact.json.gz`;
                const gcsGz = await leerArchivoGcsBuffer(gcsPrevKey);
                if (gcsGz) {
                    log('INFO', `Caché GCS hit: ${gcsPrevKey} (${(gcsGz.length / 1024).toFixed(0)} KB)`);
                    const ramKey = `preview:${anio}-${mes}:${limite}`;
                    setRamGzCache(ramKey, gcsGz);
                    if (esCompacto) return await enviarBufferJsonGzip(req, res, gcsGz);
                    const parsed = JSON.parse((await gunzipAsync(gcsGz)).toString('utf8'));
                    return await enviarJson(req, res, construirPayloadApiIncendios({
                        esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                        paisesLeidos: parsed.paisesIncluidos, totalRegistros: parsed.totalRegistros,
                        rowsCompact: null, dataObjetos: compactARegistrosObjeto(parsed.rows), truncado: parsed.truncado
                    }));
                }
            }

            if (!localHit) {
                localHit = await obtenerMesIndexado(anio, mes);
            }
            if (!localHit || !localHit.monthDir || !localHit.meta) {
                return res.status(404).json({ error: `No hay archivos de países para ${anio}-${mes} en el bucket.` });
            }

            const { monthDir, meta } = localHit;
            const paisesLeidos = meta.filesCount || 0;

            if (fecha && sinFiltrosExtra) {
                const diaNum = parseInt(fecha.slice(8, 10), 10);
                const texto = await leerDiaCacheadoTexto(monthDir, diaNum);
                const rowsCompact = [];
                let totalDia = 0;
                convertirBufferAFilasCsvCanonico(texto, (vals) => {
                    totalDia++;
                    if (rowsCompact.length < limite) rowsCompact.push(valsCanonicosACompacto(vals));
                });
                const truncado = totalDia > rowsCompact.length;
                const payloadCompact = construirPayloadApiIncendios({
                    esCompacto: true, fecha, anio, mes, pais, bbox, radio,
                    paisesLeidos, totalRegistros: totalDia, rowsCompact, dataObjetos: null, truncado
                });
                if (limite >= LIMITE_POR_DEFECTO) {
                    const gzBuf = await gzipAsync(Buffer.from(JSON.stringify(payloadCompact), 'utf8'), { level: 1 });
                    setRamGzCache(`day:${fecha}:${limite}`, gzBuf);
                    guardarEnGcsSegundoPlano(`${GCS_CACHE_PREFIX}/days/${fecha}_${limite}.compact.json.gz`, gzBuf, 'application/json; charset=utf-8', true);
                    if (esCompacto) return await enviarBufferJsonGzip(req, res, gzBuf);
                }
                if (esCompacto) return await enviarJson(req, res, payloadCompact);
                return await enviarJson(req, res, construirPayloadApiIncendios({
                    esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                    paisesLeidos, totalRegistros: totalDia, rowsCompact: null,
                    dataObjetos: compactARegistrosObjeto(rowsCompact), truncado
                }));
            }

            if (!fecha && sinFiltrosExtra && limite <= LIMITE_POR_DEFECTO) {
                const prevPath = path.join(monthDir, `preview-${limite}.json.gz`);
                if (fs.existsSync(prevPath)) {
                    const gzBuf = await fs.promises.readFile(prevPath);
                    setRamGzCache(`preview:${anio}-${mes}:${limite}`, gzBuf);
                    if (esCompacto) return await enviarBufferJsonGzip(req, res, gzBuf);
                    const parsed = JSON.parse((await gunzipAsync(gzBuf)).toString('utf8'));
                    return await enviarJson(req, res, construirPayloadApiIncendios({
                        esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                        paisesLeidos, totalRegistros: parsed.totalRegistros,
                        rowsCompact: null, dataObjetos: compactARegistrosObjeto(parsed.rows), truncado: parsed.truncado
                    }));
                }

                const muestra = await construirMuestraMesDesdeCache(monthDir, meta, limite);
                const payloadCompact = construirPayloadApiIncendios({
                    esCompacto: true, fecha, anio, mes, pais, bbox, radio,
                    paisesLeidos, totalRegistros: muestra.totalRegistros,
                    rowsCompact: muestra.rowsCompact, dataObjetos: null, truncado: muestra.truncado
                });
                const gzBuf = await gzipAsync(Buffer.from(JSON.stringify(payloadCompact), 'utf8'), { level: 1 });
                fs.promises.writeFile(prevPath, gzBuf).catch(() => {});
                setRamGzCache(`preview:${anio}-${mes}:${limite}`, gzBuf);
                guardarEnGcsSegundoPlano(`${GCS_CACHE_PREFIX}/months/${anio}_${mes}_preview_${limite}.compact.json.gz`, gzBuf, 'application/json; charset=utf-8', true);
                if (esCompacto) return await enviarBufferJsonGzip(req, res, gzBuf);
                return await enviarJson(req, res, construirPayloadApiIncendios({
                    esCompacto: false, fecha, anio, mes, pais, bbox, radio,
                    paisesLeidos, totalRegistros: muestra.totalRegistros, rowsCompact: null,
                    dataObjetos: compactARegistrosObjeto(muestra.rowsCompact), truncado: muestra.truncado
                }));
            }

            // Con filtros espaciales, franja horaria, límite extendido o CSV sobre índice local
            const predicado = construirPredicado({ fecha, horaInicio, horaFin, bbox, radio });
            const colector = crearColector(predicado, limite);
            const diasARecorrer = fecha
                ? [parseInt(fecha.slice(8, 10), 10)]
                : Array.from({ length: 31 }, (_, i) => i + 1).filter(d => meta.dayCounts && meta.dayCounts[d] > 0);
            for (const d of diasARecorrer) {
                const texto = await leerDiaCacheadoTexto(monthDir, d);
                if (!texto) continue;
                convertirBufferAFilasCsvCanonico(texto, (vals) => {
                    colector.add(valsCanonicosAObjeto(vals));
                });
            }
            const truncado = colector.total > colector.data.length;
            if (String(formato || '').toLowerCase() === 'csv') {
                const sufijo = fecha || `${anio}-${mes}`;
                return await enviarCsv(req, res, '\ufeff' + generarCsv(colector.data, ESQUEMA_CSV), `iris-incendios-${sufijo}-global.csv`);
            }
            const rowsCompact = esCompacto ? aCompactoFilas(colector.data) : null;
            return await enviarJson(req, res, construirPayloadApiIncendios({
                esCompacto, fecha, anio, mes, pais, bbox, radio, paisesLeidos,
                totalRegistros: colector.total, rowsCompact, dataObjetos: esCompacto ? null : colector.data, truncado
            }));
        }

        // -----------------------------------------------------------
        // RUTA ESTÁNDAR (mes actual en vivo, últimas 48h o país específico)
        // -----------------------------------------------------------
        let archivos = [];
        try {
            archivos = await listarArchivosMes(anio, mes);
        } catch (gcsErr) {
            if ((requiereDatosFrescos || esReciente48h) && NASA_MAP_KEY && !pais) {
                log('WARN', `GCS no disponible (${gcsErr.message}); usando solo NASA FIRMS en vivo.`);
            } else {
                throw gcsErr;
            }
        }
        const predicado = construirPredicado({ fecha, horaInicio, horaFin, bbox, radio });
        const colector = crearColector(predicado, limite);
        let paisesLeidos = 0;

        if (pais) {
            let registros = null;

            if (requiereDatosFrescos) {
                registros = await sincronizarPais(fechaHoy, pais, archivos);
            }

            if (registros) {
                registros.forEach(r => colector.add({ ...r, country: r.country || pais }));
                paisesLeidos = 1;
            } else {
                const archivo = await buscarArchivoPais(archivos, pais);
                if (!archivo) {
                    const sugeridos = archivos.map(a => a.pais).slice(0, 15);
                    log('WARN', `No hay archivo para "${pais}" en ${anio}-${mes}`);
                    return res.status(404).json({
                        error: `No se encontró el país "${pais}" para ${anio}-${mes}.`,
                        ejemplosDisponibles: sugeridos
                    });
                }
                log('INFO', `Leyendo ${archivo.nombre}`);
                await leerCsvGcs(archivo.file, (row) => colector.add({ ...row, country: row.country || archivo.pais }));
                paisesLeidos = 1;
            }
        } else {
            if (archivos.length === 0 && !requiereDatosFrescos && !esReciente48h) {
                return res.status(404).json({ error: `No hay archivos de países para ${anio}-${mes} en el bucket.` });
            }

            const clavesFechaObjetivo = new Set();
            await conLimite(ordenarPorTamanoDesc(archivos), CONCURRENCIA_GCS, async (a) => {
                await leerCsvGcs(a.file, (row) => {
                    if ((requiereDatosFrescos && fechaDe(row) === fechaHoy) || (esReciente48h && fechaDe(row) === fecha)) {
                        clavesFechaObjetivo.add(claveRegistro(row));
                    }
                    colector.add({ ...row, country: row.country || a.pais });
                });
                paisesLeidos++;
            });
            log('INFO', `Países leídos: ${paisesLeidos}/${archivos.length}; registros que cumplen el filtro: ${colector.total}`);

            if (requiereDatosFrescos) {
                const vivos = await obtenerMundoHoy(fechaHoy, archivos);
                let agregados = 0;
                vivos.forEach(r => {
                    if (!clavesFechaObjetivo.has(claveRegistro(r))) {
                        colector.add(r);
                        agregados++;
                    }
                });
                log('INFO', `Registros en vivo de la NASA agregados: ${agregados}`);
            } else if (esReciente48h && colector.total === 0) {
                const vivosAyer = await obtenerMundoPorFechaReciente(fecha);
                vivosAyer.forEach(r => colector.add(r));
                log('INFO', `Registros recientes NASA (${fecha}): ${colector.total}`);
            }
        }

        const truncado = colector.total > colector.data.length;
        if (truncado) log('WARN', `Resultado truncado: ${colector.total} registros, se devuelven ${colector.data.length}. Usa ?limite=N`);

        if (String(formato || '').toLowerCase() === 'csv') {
            const sufijo = fecha || `${anio}-${mes}`;
            const paisSlug = pais ? `-${String(pais).trim().replace(/\s+/g, '_')}` : '-global';
            const nombreCsv = `iris-incendios-${sufijo}${paisSlug}.csv`;
            return await enviarCsv(req, res, '\ufeff' + generarCsv(colector.data, ESQUEMA_CSV), nombreCsv);
        }

        const rowsCompact = esCompacto ? aCompactoFilas(colector.data) : null;
        return await enviarJson(req, res, construirPayloadApiIncendios({
            esCompacto, fecha, anio, mes, pais, bbox, radio, paisesLeidos,
            totalRegistros: colector.total, rowsCompact, dataObjetos: esCompacto ? null : colector.data, truncado
        }));

    } catch (error) {
        logError('/api/incendios', error);
        res.status(500).json({ error: 'Error interno al procesar la solicitud', detalle: error.message });
    }
});

// Manejador global de errores de Express (incluye JSON malformado en peticiones)
app.use((err, req, res, next) => {
    logError(`Express middleware (${req.method} ${req.originalUrl})`, err);
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        error: status === 400 ? 'Solicitud inválida' : 'Error interno del servidor',
        detalle: err.message
    });
});

process.on('unhandledRejection', (reason) => {
    try {
        logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)), { sync: true });
    } catch {
        // no-op
    }
});

process.on('uncaughtException', (err) => {
    try {
        logError('uncaughtException', err, { sync: true });
    } catch {
        // no-op
    }
});

// Arranca servidor tradicional (Render / Local) y exporta app para serverless (Vercel)
let httpServer = null;
if (require.main === module && process.env.VERCEL !== '1') {
    try {
        httpServer = app.listen(port, () => {
            log('INFO', `API inteligente corriendo en puerto ${port}`);
        });

        httpServer.on('error', (err) => {
            logError('server', err, { sync: true });
            process.exit(1);
        });
    } catch (error) {
        logError('Inicio del servidor', error, { sync: true });
        process.exit(1);
    }

    const cerrarLimpiamente = (signal) => {
        try {
            log('INFO', `Señal ${signal} recibida. Cerrando servidor y archivo de log...`, '', { sync: true });
            if (httpServer) {
                httpServer.close(() => {
                    if (logStream && !logStream.destroyed) logStream.end();
                    process.exit(0);
                });
                setTimeout(() => process.exit(0), 2000).unref();
            } else {
                if (logStream && !logStream.destroyed) logStream.end();
                process.exit(0);
            }
        } catch {
            process.exit(1);
        }
    };

    process.on('SIGINT', () => cerrarLimpiamente('SIGINT'));
    process.on('SIGTERM', () => cerrarLimpiamente('SIGTERM'));
}

module.exports = app;

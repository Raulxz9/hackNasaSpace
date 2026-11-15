require('dotenv').config();

const express = require('express');
const { Storage } = require('@google-cloud/storage');
const csv = require('csv-parser');
const axios = require('axios');
const { Readable } = require('stream');

const app = express();
const port = process.env.PORT || 3000;

const storage = new Storage();
const BUCKET_NAME = (process.env.BUCKET_NAME || 'incendios-datos-bucket-2026').trim();
const NASA_MAP_KEY = (process.env.NASA_MAP_KEY || '').trim();
const FUENTE_NASA = 'VIIRS_NOAA20_NRT';
const LIMITE_POR_DEFECTO = 100000; // máximo de registros devueltos por consulta
const CONCURRENCIA_GCS = 10;       // archivos leídos en paralelo al armar "world"

// ---------------------------------------------------------------
// LOGS
// ---------------------------------------------------------------
const log = (nivel, msg, extra = '') => {
    console.log(`[${new Date().toISOString()}] [${nivel}] ${msg}`, extra);
};

const logError = (contexto, error) => {
    log('ERROR', `${contexto}: ${error.message}`);
    if (error.response) {
        log('ERROR', `HTTP ${error.response.status}`, String(error.response.data).slice(0, 500));
    }
    if (error.code) log('ERROR', `Código: ${error.code}`);
    log('ERROR', 'Stack:', error.stack);
};

app.use((req, res, next) => {
    const inicio = Date.now();
    log('REQ', `${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
        log('RES', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio} ms)`);
    });
    next();
});

if (!NASA_MAP_KEY) {
    log('WARN', 'Falta NASA_MAP_KEY en el .env. Solo funcionarán las consultas históricas desde GCS.');
}
log('INFO', `Bucket configurado: "${BUCKET_NAME}"`);

// ---------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------
const obtenerFechaHoy = () => new Date().toISOString().slice(0, 10); // UTC, igual que acq_date

const normalizar = (s) => String(s || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');

// Esquema de TUS archivos en GCS (ej. 2000_11_Afghanistan.csv)
const ESQUEMA = ['latitude', 'longitude', 'scan', 'confidence', 'daynight',
    'datetime', 'frp', 'sensor', 'frp_log', 'scan_norm', 'frp_log_norm'];

// Fecha (YYYY-MM-DD) y hora (HHMM) de una fila, sea de tu esquema (datetime)
// o cruda de la NASA (acq_date / acq_time)
const fechaDe = (r) => String(r.datetime || r.acq_date || '').slice(0, 10);
const horaDe = (r) => {
    if (r.datetime) return String(r.datetime).slice(11, 16).replace(':', '');
    return String(r.acq_time || '').replace(':', '').padStart(4, '0');
};

const claveRegistro = (r) => `${r.latitude}-${r.longitude}-${fechaDe(r)}-${horaDe(r)}`;

// Convierte una fila de la NASA FIRMS al esquema de tus archivos
const nasaAEsquema = (r) => {
    const hhmm = String(r.acq_time || '').padStart(4, '0');
    const frp = parseFloat(r.frp);
    return {
        latitude: r.latitude,
        longitude: r.longitude,
        scan: r.scan,
        confidence: r.confidence,
        daynight: r.daynight,
        datetime: `${r.acq_date} ${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`,
        frp: r.frp,
        sensor: 'VIIRS',
        frp_log: Number.isFinite(frp) ? Math.log1p(frp) : '', // coincide con tus datos: ln(1+frp)
        scan_norm: '',      // requiere el min/max de tu ETL
        frp_log_norm: ''    // requiere el min/max de tu ETL
    };
};

const escaparCsv = (valor) => {
    const s = valor === undefined || valor === null ? '' : String(valor);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Genera el CSV con las columnas de tu esquema
const generarCsv = (registros) => {
    const filas = registros.map(r => ESQUEMA.map(c => escaparCsv(r[c])).join(','));
    return [ESQUEMA.join(','), ...filas].join('\n');
};

const parsearCsvTexto = (texto) => new Promise((resolve, reject) => {
    const filas = [];
    Readable.from([texto])
        .pipe(csv())
        .on('data', (row) => filas.push(row))
        .on('end', () => resolve(filas))
        .on('error', reject);
});

const leerCsvGcs = (file, onRow) => new Promise((resolve, reject) => {
    file.createReadStream()
        .on('error', reject)
        .pipe(csv())
        .on('data', onRow)
        .on('end', resolve)
        .on('error', reject);
});

// Ejecuta fn sobre cada elemento con un máximo de tareas en paralelo
async function conLimite(items, limite, fn) {
    let i = 0;
    const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            try {
                await fn(item);
            } catch (e) {
                logError(`procesando ${item.nombre}`, e);
            }
        }
    });
    await Promise.all(trabajadores);
}

// Filtro común (fecha exacta y rango de horas)
const construirPredicado = ({ fecha, horaInicio, horaFin }) => {
    const hInicio = horaInicio ? horaInicio.replace(':', '').padStart(4, '0') : null;
    const hFin = horaFin ? horaFin.replace(':', '').padStart(4, '0') : null;
    return (row) => {
        if (fecha && fechaDe(row) !== fecha) return false;
        if (hInicio && hFin) {
            const h = horaDe(row);
            if (h < hInicio || h > hFin) return false;
        }
        return true;
    };
};

// Acumula filas que cumplen el filtro; guarda hasta "limite" pero cuenta todas
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
// GCS: archivos del mes (uno por país: 2000_11_Afghanistan.csv)
// ---------------------------------------------------------------
async function listarArchivosMes(anio, mes) {
    const prefijo = `${anio}_${mes}_`;
    const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: prefijo });
    const archivos = files
        .filter(f => f.name.toLowerCase().endsWith('.csv'))
        .map(f => ({
            file: f,
            nombre: f.name,
            pais: f.name.slice(prefijo.length, -4).replace(/_/g, ' ')
        }))
        .filter(a => normalizar(a.pais) !== 'world'); // se arma al vuelo, no se lee
    log('INFO', `GCS: ${archivos.length} archivos de país con prefijo "${prefijo}"`);
    return archivos;
}

// ---------------------------------------------------------------
// NASA FIRMS
// ---------------------------------------------------------------
const ocultarKey = (url) => (NASA_MAP_KEY ? url.replace(NASA_MAP_KEY, '***') : url);

async function pedirCsvNasa(url) {
    log('INFO', `Consultando NASA: ${ocultarKey(url)}`);
    const response = await axios.get(url, { timeout: 120000, responseType: 'text' });
    const texto = response.data;
    log('INFO', `NASA respondió HTTP ${response.status}, ${String(texto).length} caracteres`);

    // La NASA responde 200 con texto de error si la key es inválida o se excede el límite
    if (typeof texto !== 'string' || !texto.startsWith('latitude')) {
        log('ERROR', 'Respuesta inesperada de la NASA:', String(texto).slice(0, 300));
        return null;
    }
    return parsearCsvTexto(texto);
}

// Lista de países de FIRMS (nombre <-> código ISO3), con caché en memoria
let cachePaises = null;
async function cargarPaisesFirms() {
    if (cachePaises) return cachePaises;
    const porNombre = new Map();
    const porCodigo = new Map();
    try {
        const r = await axios.get('https://firms.modaps.eosdis.nasa.gov/api/countries/?format=csv', {
            timeout: 30000, responseType: 'text'
        });
        const lineas = String(r.data).split(/\r?\n/).filter(Boolean);
        const sep = lineas[0].includes(';') ? ';' : ',';
        const cab = lineas[0].split(sep).map(c => c.trim().toLowerCase());
        const iCod = cab.findIndex(c => c === 'abreviation' || c === 'abbreviation');
        const iNom = cab.findIndex(c => c === 'name');
        if (iCod === -1 || iNom === -1) throw new Error(`Columnas inesperadas: ${lineas[0]}`);
        lineas.slice(1).forEach(l => {
            const p = l.split(sep);
            const codigo = (p[iCod] || '').trim().toUpperCase();
            const nombre = (p[iNom] || '').trim();
            if (codigo && nombre) {
                porNombre.set(normalizar(nombre), { codigo, nombre });
                porCodigo.set(codigo, { codigo, nombre });
            }
        });
        log('INFO', `Países FIRMS cargados: ${porCodigo.size}`);
        cachePaises = { porNombre, porCodigo };
    } catch (e) {
        logError('cargarPaisesFirms', e);
        log('WARN', 'No se pudo cargar la lista de países; solo funcionarán códigos ISO3 (ej. MEX).');
        return { porNombre, porCodigo }; // sin caché para reintentar después
    }
    return cachePaises;
}

// "Mexico" o "MEX" -> { codigo, nombre }
async function resolverPais(entrada) {
    const { porNombre, porCodigo } = await cargarPaisesFirms();
    const limpio = entrada.trim();
    if (/^[A-Za-z]{3}$/.test(limpio)) {
        const codigo = limpio.toUpperCase();
        const info = porCodigo.get(codigo);
        return { codigo, nombre: info ? info.nombre : limpio };
    }
    const info = porNombre.get(normalizar(limpio));
    return { codigo: info ? info.codigo : null, nombre: info ? info.nombre : limpio };
}

// Sincroniza el CSV de UN país con los datos recientes de la NASA y lo guarda en GCS
async function sincronizarPais(fechaHoy, pais, archivos) {
    const [anio, mes] = fechaHoy.split('-');
    try {
        if (!NASA_MAP_KEY) {
            log('ERROR', 'NASA_MAP_KEY vacío: no se puede sincronizar.');
            return null;
        }
        const { codigo, nombre } = await resolverPais(pais);
        if (!codigo) {
            log('ERROR', `No se encontró código ISO3 para "${pais}". Usa un código (MEX, USA...) o un nombre en inglés.`);
            return null;
        }

        const url = `https://firms.modaps.eosdis.nasa.gov/api/country/csv/${NASA_MAP_KEY}/${FUENTE_NASA}/${codigo}/1`;
        const filasNasa = await pedirCsvNasa(url);
        if (!filasNasa) return null;

        const prefijoMes = `${anio}-${mes}`;
        const registrosNasa = filasNasa
            .filter(r => String(r.acq_date || '').startsWith(prefijoMes))
            .map(nasaAEsquema);
        log('INFO', `NASA (${codigo}): ${filasNasa.length} filas, ${registrosNasa.length} pertenecen a ${prefijoMes}`);

        // Archivo existente (si lo hay) o nombre nuevo con el mismo formato que los demás
        const existente = archivos.find(a =>
            normalizar(a.pais) === normalizar(nombre) || normalizar(a.pais) === normalizar(pais));
        const file = existente
            ? existente.file
            : storage.bucket(BUCKET_NAME).file(`${anio}_${mes}_${nombre.trim().replace(/\s+/g, '_')}.csv`);

        const registrosExistentes = [];
        if (existente) {
            await leerCsvGcs(file, (row) => registrosExistentes.push(row));
        }
        log('INFO', `Registros existentes en ${file.name}: ${registrosExistentes.length}`);

        const mapaUnico = new Map();
        [...registrosExistentes, ...registrosNasa].forEach(r => mapaUnico.set(claveRegistro(r), r));
        const registrosFinales = Array.from(mapaUnico.values());
        log('INFO', `Tras fusionar: ${registrosFinales.length} (nuevos: ${registrosFinales.length - registrosExistentes.length})`);

        if (registrosFinales.length > 0) {
            await file.save(generarCsv(registrosFinales), { contentType: 'text/csv' });
            log('INFO', `CSV guardado: ${file.name} (${registrosFinales.length} registros)`);
        }
        return registrosFinales;
    } catch (error) {
        logError('sincronizarPais', error);
        return null;
    }
}

// Datos de HOY de todo el mundo (en memoria, con caché de 5 min). No se guardan
// en GCS porque la NASA no indica el país en el CSV mundial.
let cacheMundoHoy = { fecha: null, ts: 0, filas: [] };
async function obtenerMundoHoy(fechaHoy) {
    if (!NASA_MAP_KEY) return [];
    if (cacheMundoHoy.fecha === fechaHoy && Date.now() - cacheMundoHoy.ts < 5 * 60 * 1000) {
        log('INFO', `Usando caché de NASA mundial (${cacheMundoHoy.filas.length} filas)`);
        return cacheMundoHoy.filas;
    }
    try {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_MAP_KEY}/${FUENTE_NASA}/world/1`;
        const filas = await pedirCsvNasa(url);
        if (!filas) return [];
        const deHoy = filas.filter(r => r.acq_date === fechaHoy).map(nasaAEsquema);
        log('INFO', `NASA mundial: ${filas.length} filas, ${deHoy.length} de ${fechaHoy}`);
        cacheMundoHoy = { fecha: fechaHoy, ts: Date.now(), filas: deHoy };
        return deHoy;
    } catch (error) {
        logError('obtenerMundoHoy', error);
        return [];
    }
}

// ---------------------------------------------------------------
// ENDPOINT
// ---------------------------------------------------------------
app.get('/api/incendios', async (req, res) => {
    try {
        log('INFO', 'Parámetros recibidos:', JSON.stringify(req.query));
        const { fecha, mesConsulta, anioConsulta, pais, horaInicio, horaFin } = req.query;
        const limite = Math.max(1, parseInt(req.query.limite, 10) || LIMITE_POR_DEFECTO);
        const fechaHoy = obtenerFechaHoy();

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
        const esMesActual = `${anio}-${mes}` === fechaHoy.slice(0, 7);
        const requiereDatosFrescos = esHoy || (!fecha && esMesActual);

        const archivos = await listarArchivosMes(anio, mes);
        const predicado = construirPredicado({ fecha, horaInicio, horaFin });
        const colector = crearColector(predicado, limite);
        let paisesLeidos = 0;

        if (pais) {
            // ---------- Un solo país ----------
            let registros = null;

            if (requiereDatosFrescos) {
                registros = await sincronizarPais(fechaHoy, pais, archivos);
            }

            if (registros) {
                registros.forEach(r => colector.add(r));
                paisesLeidos = 1;
            } else {
                const archivo = archivos.find(a => normalizar(a.pais) === normalizar(pais));
                if (!archivo) {
                    const sugeridos = archivos.map(a => a.pais).slice(0, 15);
                    log('WARN', `No hay archivo para "${pais}" en ${anio}-${mes}`);
                    return res.status(404).json({
                        error: `No se encontró el país "${pais}" para ${anio}-${mes}.`,
                        ejemplosDisponibles: sugeridos
                    });
                }
                log('INFO', `Leyendo ${archivo.nombre}`);
                await leerCsvGcs(archivo.file, (row) => colector.add(row));
                paisesLeidos = 1;
            }
        } else {
            // ---------- Mundo: se arma uniendo todos los países ----------
            if (archivos.length === 0 && !requiereDatosFrescos) {
                return res.status(404).json({ error: `No hay archivos de países para ${anio}-${mes} en el bucket.` });
            }

            const clavesHoy = new Set(); // para no duplicar con los datos en vivo de la NASA
            await conLimite(archivos, CONCURRENCIA_GCS, async (a) => {
                await leerCsvGcs(a.file, (row) => {
                    if (requiereDatosFrescos && fechaDe(row) === fechaHoy) clavesHoy.add(claveRegistro(row));
                    colector.add({ ...row, country: row.country || a.pais });
                });
                paisesLeidos++;
            });
            log('INFO', `Países leídos: ${paisesLeidos}/${archivos.length}; registros que cumplen el filtro: ${colector.total}`);

            if (requiereDatosFrescos) {
                const vivos = await obtenerMundoHoy(fechaHoy);
                let agregados = 0;
                vivos.forEach(r => {
                    if (!clavesHoy.has(claveRegistro(r))) {
                        colector.add(r);
                        agregados++;
                    }
                });
                log('INFO', `Registros en vivo de la NASA agregados: ${agregados}`);
            }
        }

        const truncado = colector.total > colector.data.length;
        if (truncado) log('WARN', `Resultado truncado: ${colector.total} registros, se devuelven ${colector.data.length}. Usa ?limite=N`);

        res.json({
            filtrosAplicados: { fecha: fecha || 'Todo el mes', mes: `${anio}-${mes}`, pais: pais || 'Global' },
            paisesIncluidos: paisesLeidos,
            totalRegistros: colector.total,
            devueltos: colector.data.length,
            truncado,
            data: colector.data
        });

    } catch (error) {
        logError('/api/incendios', error);
        res.status(500).json({ error: 'Error interno al procesar la solicitud', detalle: error.message });
    }
});

process.on('unhandledRejection', (reason) => log('ERROR', 'unhandledRejection:', reason));
process.on('uncaughtException', (err) => logError('uncaughtException', err));

const server = app.listen(port, () => {
    log('INFO', `API inteligente corriendo en http://localhost:${port}`);
});

server.on('error', (err) => {
    logError('server', err); // ej. EADDRINUSE si el puerto está ocupado
    process.exit(1);
});
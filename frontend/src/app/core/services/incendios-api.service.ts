import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  catchError,
  finalize,
  forkJoin,
  map,
  of,
  retry,
  switchMap,
  tap,
  throwError,
  timeout,
  timer
} from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  AlertHotspot,
  HotspotFeature,
  HotspotFeatureCollection,
  Incendio,
  IncendiosApiResponse,
  IncendiosQueryParams,
  OrigenCalor,
  RawIncendioRecord,
  ResumenCalendario,
  ResumenMesItem,
  SeveridadNivel
} from '../models';

export type BackendConnectionState = 'idle' | 'connecting' | 'waking' | 'ready' | 'error';

export interface MonthHotspotsResult {
  fc: HotspotFeatureCollection;
  totalRegistros: number;
  truncado: boolean;
}

interface CompactCellStat {
  firstDay: string;
  days?: Set<string>;
  hits: number;
  frpSum: number;
  frpSqSum: number;
}

interface ParsedConfidence {
  confidence: number;
  confidenceLabel: string;
}

const CONFIDENCE_PRESETS: Record<string, ParsedConfidence> = {
  h: { confidence: 90, confidenceLabel: 'Alta (h)' },
  H: { confidence: 90, confidenceLabel: 'Alta (h)' },
  high: { confidence: 90, confidenceLabel: 'Alta (h)' },
  n: { confidence: 70, confidenceLabel: 'Nominal (n)' },
  N: { confidence: 70, confidenceLabel: 'Nominal (n)' },
  nominal: { confidence: 70, confidenceLabel: 'Nominal (n)' },
  l: { confidence: 40, confidenceLabel: 'Baja (l)' },
  L: { confidence: 40, confidenceLabel: 'Baja (l)' },
  low: { confidence: 40, confidenceLabel: 'Baja (l)' }
};
const DEFAULT_CONFIDENCE: ParsedConfidence = { confidence: 70, confidenceLabel: 'Nominal' };
const INV_LN_1001 = 1 / Math.log1p(1000);
const DEFAULT_COMPACT_COLS = [
  'latitude',
  'longitude',
  'scan',
  'confidence',
  'daynight',
  'datetime',
  'frp',
  'sensor',
  'frp_log_norm',
  'country'
];

interface SpatialBbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const KNOWN_VOLCANOES: ReadonlyArray<[number, number]> = [
  [19.023, -98.622], // Popocatépetl, MX
  [19.512, -103.617], // Colima, MX
  [14.474, -90.880], // Fuego, GT
  [14.756, -91.552], // Santiaguito, GT
  [14.382, -90.601], // Pacaya, GT
  [11.984, -86.161], // Masaya, NI
  [10.025, -83.767], // Turrialba, CR
  [-0.077, -77.656], // Reventador, EC
  [-2.002, -78.341], // Sangay, EC
  [-0.677, -78.436], // Cotopaxi, EC
  [-15.787, -71.857], // Sabancaya, PE
  [-39.420, -71.930], // Villarrica, CL
  [37.748, 14.999], // Etna, IT
  [38.789, 15.213], // Stromboli, IT
  [19.407, -155.283], // Kīlauea, US
  [19.475, -155.608], // Mauna Loa, US
  [13.600, 40.670], // Erta Ale, ET
  [-1.520, 29.250], // Nyiragongo, CD
  [-1.408, 29.200], // Nyamuragira, CD
  [-21.244, 55.708], // Piton de la Fournaise, RE
  [-7.540, 110.446], // Merapi, ID
  [-8.108, 112.922], // Semeru, ID
  [-6.102, 105.423], // Krakatau, ID
  [1.680, 127.880], // Dukono, ID
  [1.488, 127.630], // Ibu, ID
  [-8.542, 122.775], // Lewotobi, ID
  [31.593, 130.657], // Sakurajima, JP
  [32.884, 131.104], // Aso, JP
  [29.638, 129.714], // Suwanosejima, JP
  [56.056, 160.642], // Klyuchevskoy, RU
  [56.653, 161.360], // Shiveluch, RU
  [-19.532, 169.447], // Yasur, VU
  [63.880, -22.390], // Reykjanes / Grindavik, IS
  [13.257, 123.685], // Mayon, PH
  [14.002, 120.993] // Taal, PH
];

const OFFSHORE_MARINE_ZONES: ReadonlyArray<SpatialBbox> = [
  { minLat: 18.4, maxLat: 20.6, minLon: -93.2, maxLon: -91.2 }, // Sonda de Campeche
  { minLat: 26.8, maxLat: 29.2, minLon: -93.5, maxLon: -88.5 }, // Gulf of Mexico offshore
  { minLat: 55.5, maxLat: 62.2, minLon: -1.5, maxLon: 5.5 }, // North Sea
  { minLat: 24.6, maxLat: 29.9, minLon: 48.2, maxLon: 56.4 }, // Persian Gulf
  { minLat: 39.5, maxLat: 45.2, minLon: 49.5, maxLon: 53.5 }, // Caspian Sea
  { minLat: 1.5, maxLat: 4.9, minLon: 2.5, maxLon: 8.4 }, // Gulf of Guinea offshore
  { minLat: -8.0, maxLat: -4.8, minLon: 11.2, maxLon: 13.2 }, // Angola offshore
  { minLat: 9.5, maxLat: 10.7, minLon: -71.8, maxLon: -71.1 }, // Lake Maracaibo offshore
  { minLat: -25.5, maxLat: -21.5, minLon: -43.5, maxLon: -39.5 }, // Campos/Santos offshore
  { minLat: 3.5, maxLat: 6.5, minLon: 111.5, maxLon: 115.5 }, // South China Sea offshore
  { minLat: 27.0, maxLat: 28.5, minLon: 33.2, maxLon: 34.3 } // Red Sea offshore
];

const KNOWN_INDUSTRIAL_ZONES: ReadonlyArray<[number, number]> = [
  [29.73, -95.08], // Houston Ship Channel
  [29.90, -93.93], // Port Arthur / Beaumont
  [27.01, 49.58], // Jubail Petrochemical
  [51.45, 6.95], // Ruhr Valley
  [39.63, 118.18], // Tangshan Steel
  [30.52, 47.65], // Basra / Rumaila flares
  [5.05, 6.65], // Niger Delta gas flares
  [31.80, -102.35], // Permian Basin Midland/Odessa
  [57.03, -111.60], // Alberta Oil Sands
  [51.28, 4.30], // Antwerp / Rotterdam
  [26.05, -97.95] // Burgos Basin flares
];

export function dayNumFromUtcDate(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return Math.floor(Date.now() / 864e5);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5);
}

export function classifySeverityByFrp(frp: number): SeveridadNivel {
  if (!Number.isFinite(frp) || frp < 15) return 1;
  if (frp < 50) return 2;
  if (frp < 150) return 3;
  if (frp < 400) return 4;
  return 5;
}

@Injectable({ providedIn: 'root' })
export class IncendiosApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl.replace(/\/$/, '');

  readonly serverStatus = signal<BackendConnectionState>('idle');
  readonly activeRequests = signal<number>(0);
  readonly liveWindowMode = signal<'today' | '48h'>('today');
  readonly lastSyncUtc = signal<string | null>(null);
  readonly lastError = signal<string | null>(null);

  private readonly monthCache = new Map<string, MonthHotspotsResult>();
  private readonly dayCache = new Map<string, HotspotFeatureCollection>();
  private readonly summaryCache = new Map<string, ResumenCalendario>();
  private readonly yearSummaryCache = new Map<string, ResumenMesItem[]>();
  private readonly dayNumMemo = new Map<string, number>();

  private trackRequest<T>(obs$: Observable<T>): Observable<T> {
    this.activeRequests.update((n) => n + 1);
    if (this.serverStatus() !== 'waking') {
      this.serverStatus.set('connecting');
    }
    this.lastError.set(null);

    let wokeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (this.activeRequests() > 0) {
        this.serverStatus.set('waking');
      }
    }, 3500);

    return obs$.pipe(
      timeout(environment.requestTimeoutMs),
      retry({
        count: 2,
        delay: (error, retryCount) => {
          const status = error?.status;
          const isTimeout = error?.name === 'TimeoutError';
          // Solo reintentar errores de red, timeout o cold start / puerta de enlace (502/503/504/408/429)
          const isTransient =
            isTimeout ||
            !status ||
            status === 0 ||
            status === 408 ||
            status === 429 ||
            status === 502 ||
            status === 503 ||
            status === 504;
          if (!isTransient) {
            return throwError(() => error);
          }
          this.serverStatus.set('waking');
          return timer(retryCount * 2000);
        }
      }),
      tap(() => {
        this.serverStatus.set('ready');
        this.lastSyncUtc.set(new Date().toISOString());
      }),
      catchError((err: unknown): Observable<never> => {
        const httpErr = err as { error?: { error?: string }; message?: string };
        this.serverStatus.set('error');
        this.lastError.set(httpErr?.error?.error || httpErr?.message || 'Error de conexión con el servidor');
        return throwError(() => err);
      }),
      finalize(() => {
        if (wokeTimer) {
          clearTimeout(wokeTimer);
          wokeTimer = null;
        }
        const remaining = Math.max(0, this.activeRequests() - 1);
        this.activeRequests.set(remaining);
        if (remaining === 0 && this.serverStatus() === 'connecting') {
          this.serverStatus.set('ready');
        }
      })
    );
  }

  private buildHttpParams(params: IncendiosQueryParams): HttpParams {
    let hp = new HttpParams();
    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== '') {
        hp = hp.set(key, String(val));
      }
    });
    return hp;
  }

  private getDayNumFast(dateStr: string): number {
    let cached = this.dayNumMemo.get(dateStr);
    if (cached !== undefined) return cached;
    cached = dayNumFromUtcDate(dateStr);
    if (this.dayNumMemo.size > 4000) this.dayNumMemo.clear();
    this.dayNumMemo.set(dateStr, cached);
    return cached;
  }

  private countResponseRows(res: IncendiosApiResponse | null | undefined): number {
    if (!res) return 0;
    if (res.compact && Array.isArray(res.rows)) return res.rows.length;
    return res.data?.length ?? 0;
  }

  getCachedYearSummary(anioConsulta: number, pais?: string): ResumenMesItem[] | null {
    const key = `${anioConsulta}:${(pais || 'global').toLowerCase()}`;
    return this.yearSummaryCache.get(key) || null;
  }

  fetchIncendiosRaw(params: IncendiosQueryParams): Observable<IncendiosApiResponse> {
    const queryParams: IncendiosQueryParams =
      params.formato === 'csv' || params.compact !== undefined ? params : { ...params, compact: 1 };
    const httpParams = this.buildHttpParams(queryParams);
    return this.trackRequest(
      this.http.get<IncendiosApiResponse>(`${this.baseUrl}/api/incendios`, { params: httpParams })
    );
  }

  fetchLiveHotspots(): Observable<HotspotFeatureCollection> {
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const yesterdayIso = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

    return this.fetchIncendiosRaw({ fecha: todayIso }).pipe(
      switchMap((todayRes) => {
        const todayCount = this.countResponseRows(todayRes);
        // Si el día UTC actual aún tiene pocos registros en NASA NRT, retrocede automáticamente a últimas 24–48h
        if (todayCount >= 30) {
          this.liveWindowMode.set('today');
          return of(this.mapApiResponsesToGeoJson([todayRes]));
        }

        return this.fetchIncendiosRaw({ fecha: yesterdayIso }).pipe(
          map((yesterdayRes) => {
            this.liveWindowMode.set('48h');
            return this.mapApiResponsesToGeoJson([todayRes, yesterdayRes]);
          }),
          catchError(() => {
            this.liveWindowMode.set('today');
            return of(this.mapApiResponsesToGeoJson([todayRes]));
          })
        );
      }),
      catchError((err) => {
        // Fallback por si el día UTC actual todavía no tiene archivo/datos en GCS
        if (err?.status === 404) {
          return this.fetchIncendiosRaw({ fecha: yesterdayIso }).pipe(
            map((yesterdayRes) => {
              this.liveWindowMode.set('48h');
              return this.mapApiResponsesToGeoJson([yesterdayRes]);
            })
          );
        }
        return throwError(() => err);
      })
    );
  }

  fetchMonthWithMeta(anio: number, mes: number, pais?: string): Observable<MonthHotspotsResult> {
    const key = `${anio}-${String(mes).padStart(2, '0')}:${(pais || 'global').toLowerCase()}`;
    const currentUtcYm = new Date().toISOString().slice(0, 7);
    const isCurrentMonth = `${anio}-${String(mes).padStart(2, '0')}` === currentUtcYm;

    const cached = this.monthCache.get(key);
    if (cached && !isCurrentMonth) {
      return of(cached);
    }

    return this.fetchIncendiosRaw({
      anioConsulta: anio,
      mesConsulta: mes,
      pais
    }).pipe(
      map((res) => {
        const fc = this.mapApiResponsesToGeoJson([res]);
        const result: MonthHotspotsResult = {
          fc,
          totalRegistros: Number(res.totalRegistros ?? fc.features.length),
          truncado: Boolean(res.truncado)
        };
        if (!isCurrentMonth) {
          this.monthCache.set(key, result);
        }
        return result;
      }),
      catchError((err) => {
        if (err?.status === 404) {
          return of({
            fc: { type: 'FeatureCollection', features: [] } as HotspotFeatureCollection,
            totalRegistros: 0,
            truncado: false
          });
        }
        return throwError(() => err);
      })
    );
  }

  fetchMonthHotspots(anio: number, mes: number, pais?: string): Observable<HotspotFeatureCollection> {
    return this.fetchMonthWithMeta(anio, mes, pais).pipe(map((r) => r.fc));
  }

  fetchDayHotspots(fecha: string, pais?: string): Observable<HotspotFeatureCollection> {
    const todayIso = new Date().toISOString().slice(0, 10);
    const isToday = fecha === todayIso;
    const key = `${fecha}:${(pais || 'global').toLowerCase()}`;
    const cached = this.dayCache.get(key);
    if (cached && !isToday) {
      return of(cached);
    }

    return this.fetchIncendiosRaw({ fecha, pais }).pipe(
      map((res) => {
        const fc = this.mapApiResponsesToGeoJson([res]);
        if (!isToday) {
          this.dayCache.set(key, fc);
        }
        return fc;
      }),
      catchError((err) => {
        if (err?.status === 404) {
          return of({ type: 'FeatureCollection', features: [] } as HotspotFeatureCollection);
        }
        return throwError(() => err);
      })
    );
  }

  fetchSpatialHotspots(params: IncendiosQueryParams): Observable<HotspotFeatureCollection> {
    return this.fetchIncendiosRaw(params).pipe(
      map((res) => this.mapApiResponsesToGeoJson([res]))
    );
  }

  fetchResumen(
    anioConsulta: number,
    mesConsulta?: number,
    pais?: string,
    modo?: 'rapido' | 'completo'
  ): Observable<ResumenCalendario> {
    const yearKey = `${anioConsulta}:${(pais || 'global').toLowerCase()}`;
    const key = `${anioConsulta}-${mesConsulta ?? 'all'}:${(pais || 'global').toLowerCase()}`;
    const currentYear = new Date().getUTCFullYear();
    const cached = this.summaryCache.get(key);
    if (cached && anioConsulta < currentYear) {
      return of(cached);
    }

    let params = new HttpParams().set('anioConsulta', String(anioConsulta));
    if (mesConsulta !== undefined) {
      params = params.set('mesConsulta', String(mesConsulta));
    }
    if (pais) {
      params = params.set('pais', pais);
    }
    if (modo === 'rapido') {
      params = params.set('modo', 'rapido');
    }

    return this.trackRequest(
      this.http.get<ResumenCalendario>(`${this.baseUrl}/api/incendios/resumen`, { params })
    ).pipe(
      map((res) => {
        const prevYearBars = this.yearSummaryCache.get(yearKey);
        let mergedMensual = res.resumenMensual;
        if (res.parcial && prevYearBars && prevYearBars.length === 12) {
          mergedMensual = res.resumenMensual.map((item, idx) =>
            item.totalFocos > 0 ? item : prevYearBars[idx] || item
          );
        } else if (!res.parcial && Array.isArray(res.resumenMensual) && res.resumenMensual.length === 12) {
          this.yearSummaryCache.set(yearKey, res.resumenMensual);
        } else if (Array.isArray(res.resumenMensual) && res.resumenMensual.length === 12) {
          const updated = prevYearBars ? [...prevYearBars] : res.resumenMensual.map((m) => ({ ...m }));
          res.resumenMensual.forEach((m, idx) => {
            if (m.totalFocos > 0) updated[idx] = m;
          });
          this.yearSummaryCache.set(yearKey, updated);
        }
        return mergedMensual === res.resumenMensual ? res : { ...res, resumenMensual: mergedMensual };
      }),
      tap((res) => {
        if (anioConsulta < currentYear && !res.parcial) {
          this.summaryCache.set(key, res);
        }
      })
    );
  }

  buildBackendCsvUrl(params: IncendiosQueryParams): string {
    const hp = this.buildHttpParams({ ...params, formato: 'csv' });
    return `${this.baseUrl}/api/incendios?${hp.toString()}`;
  }

  wakeServer(): Observable<{ status: string }> {
    return this.trackRequest(this.http.get<{ status: string }>(`${this.baseUrl}/api/health`)).pipe(
      catchError(() => of({ status: 'offline' }))
    );
  }

  private pushHotspotRow(
    features: HotspotFeature[],
    cellKeys: string[],
    seen: Set<string>,
    cellStats: Map<string, CompactCellStat>,
    distinctDates: Set<string>,
    defaultDate: string,
    rawLatVal: unknown,
    rawLonVal: unknown,
    rawDatetime: unknown,
    rawFrpVal: unknown,
    rawFrpLogNormVal: unknown,
    rawScanVal: unknown,
    rawConfidence: unknown,
    rawCountry: unknown,
    rawSensor: unknown,
    rawDaynight: unknown
  ): void {
    const rawLat = typeof rawLatVal === 'number' ? rawLatVal : parseFloat(String(rawLatVal));
    const rawLon = typeof rawLonVal === 'number' ? rawLonVal : parseFloat(String(rawLonVal));
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon)) return;

    // Redondear antes de calcular la clave de celda evita desajustes de borde con coordenadas de 5 decimales de la NASA
    const lat = Math.round(rawLat * 10000) / 10000;
    const lon = Math.round(rawLon * 10000) / 10000;

    const dtStr = typeof rawDatetime === 'string' ? rawDatetime.trim() : String(rawDatetime || '').trim();
    const date = dtStr.length >= 10 ? dtStr.slice(0, 10) : defaultDate;
    const time = dtStr.length >= 16 ? dtStr.slice(11, 16) : '00:00';
    const id = `${lat}_${lon}_${date}_${time}`;
    if (seen.has(id)) return;
    seen.add(id);

    const rawFrp = typeof rawFrpVal === 'number' ? rawFrpVal : parseFloat(String(rawFrpVal));
    const frp = Number.isFinite(rawFrp) ? Math.round(rawFrp * 10) / 10 : 0;
    const rawFln =
      typeof rawFrpLogNormVal === 'number' ? rawFrpLogNormVal : parseFloat(String(rawFrpLogNormVal));
    const frpLogNorm = Number.isFinite(rawFln)
      ? rawFln
      : Math.min(1, Math.log1p(Math.max(0, frp)) * INV_LN_1001);
    const rawScan = typeof rawScanVal === 'number' ? rawScanVal : parseFloat(String(rawScanVal));
    const scan = Number.isFinite(rawScan) ? rawScan : 0.4;

    const { confidence, confidenceLabel } = this.parseConfidence(
      rawConfidence as string | number | undefined
    );
    const sev = classifySeverityByFrp(frp);
    const country = typeof rawCountry === 'string' ? rawCountry.trim() : String(rawCountry || '').trim();
    const sensorStr = typeof rawSensor === 'string' ? rawSensor.trim() : String(rawSensor || '').trim();
    const sensor = sensorStr || 'VIIRS';
    const dnStr = typeof rawDaynight === 'string' ? rawDaynight.trim() : String(rawDaynight || '').trim();
    const daynight = dnStr || 'D';

    distinctDates.add(date);
    const cellKey = `${Math.round(lat * 50)},${Math.round(lon * 50)}`;
    let cell = cellStats.get(cellKey);
    if (!cell) {
      cell = {
        firstDay: date,
        hits: 1,
        frpSum: frp,
        frpSqSum: frp * frp
      };
      cellStats.set(cellKey, cell);
    } else {
      cell.hits++;
      cell.frpSum += frp;
      cell.frpSqSum += frp * frp;
      if (cell.days) {
        cell.days.add(date);
      } else if (date !== cell.firstDay) {
        cell.days = new Set<string>([cell.firstDay, date]);
      }
    }

    const regionLabel = country || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    cellKeys.push(cellKey);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lon, lat]
      },
      properties: {
        id,
        day: this.getDayNumFast(date),
        date,
        time,
        sev,
        frp,
        frp_log_norm: frpLogNorm,
        scan,
        conf: confidence,
        confLabel: confidenceLabel,
        daynight,
        sensor,
        country,
        region: regionLabel,
        src: 'veg'
      }
    });
  }

  mapApiResponsesToGeoJson(responses: IncendiosApiResponse[]): HotspotFeatureCollection {
    const features: HotspotFeature[] = [];
    const cellKeys: string[] = [];
    const seen = new Set<string>();
    const cellStats = new Map<string, CompactCellStat>();
    const distinctDates = new Set<string>();
    const defaultDate = new Date().toISOString().slice(0, 10);

    for (const res of responses) {
      if (!res) continue;
      if (res.compact && Array.isArray(res.rows)) {
        const cols = res.columns && res.columns.length ? res.columns : DEFAULT_COMPACT_COLS;
        const latIdx = cols.indexOf('latitude');
        const lonIdx = cols.indexOf('longitude');
        const scanIdx = cols.indexOf('scan');
        const confIdx = cols.indexOf('confidence');
        const dnIdx = cols.indexOf('daynight');
        const dtIdx = cols.indexOf('datetime');
        const frpIdx = cols.indexOf('frp');
        const senIdx = cols.indexOf('sensor');
        const flnIdx = cols.indexOf('frp_log_norm');
        const ctyIdx = cols.indexOf('country');

        for (const r of res.rows) {
          this.pushHotspotRow(
            features,
            cellKeys,
            seen,
            cellStats,
            distinctDates,
            defaultDate,
            r[latIdx],
            r[lonIdx],
            r[dtIdx],
            r[frpIdx],
            r[flnIdx],
            r[scanIdx],
            r[confIdx],
            r[ctyIdx],
            r[senIdx],
            r[dnIdx]
          );
        }
      } else if (Array.isArray(res.data)) {
        for (const r of res.data) {
          this.pushHotspotRow(
            features,
            cellKeys,
            seen,
            cellStats,
            distinctDates,
            defaultDate,
            r.latitude,
            r.longitude,
            r.datetime || r.acq_date || '',
            r.frp,
            r.frp_log_norm,
            r.scan,
            r.confidence,
            r.country,
            r.sensor,
            r.daynight
          );
        }
      }
    }

    if (!features.length) {
      return { type: 'FeatureCollection', features };
    }

    const isMultiDayDataset = distinctDates.size >= 4;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const coords = f.geometry.coordinates;
      const cell = cellStats.get(cellKeys[i]);
      f.properties.src = this.classifyHeatSource(coords[1], coords[0], f.properties.frp, cell, isMultiDayDataset);
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

  mapRecordsToGeoJson(records: RawIncendioRecord[]): HotspotFeatureCollection {
    if (!records.length) {
      return { type: 'FeatureCollection', features: [] };
    }
    return this.mapApiResponsesToGeoJson([
      {
        filtrosAplicados: { fecha: '', mes: '', pais: '' },
        paisesIncluidos: 0,
        totalRegistros: records.length,
        devueltos: records.length,
        truncado: false,
        data: records
      }
    ]);
  }

  extractTopAlerts(fc: HotspotFeatureCollection, maxAlerts = 3): AlertHotspot[] {
    const highPriority = fc.features
      .filter((f) => f.properties.sev >= 3)
      .sort((a, b) => b.properties.frp - a.properties.frp)
      .slice(0, maxAlerts);

    const fallback = highPriority.length
      ? highPriority
      : fc.features.slice().sort((a, b) => b.properties.frp - a.properties.frp).slice(0, maxAlerts);

    return fallback.map((f) => ({
      id: f.properties.id,
      sev: f.properties.sev,
      frp: f.properties.frp,
      country: f.properties.country || `${f.geometry.coordinates[1].toFixed(2)}, ${f.geometry.coordinates[0].toFixed(2)}`,
      coordinates: f.geometry.coordinates,
      datetime: `${f.properties.date} ${f.properties.time}`,
      sensor: f.properties.sensor
    }));
  }

  private parseConfidence(raw: string | number | undefined): ParsedConfidence {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      const preset = CONFIDENCE_PRESETS[trimmed] || CONFIDENCE_PRESETS[trimmed.toLowerCase()];
      if (preset) return preset;
      const n = parseFloat(trimmed);
      if (Number.isFinite(n)) {
        const clamped = Math.max(0, Math.min(100, Math.round(n)));
        return { confidence: clamped, confidenceLabel: `${clamped}%` };
      }
      return DEFAULT_CONFIDENCE;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const clamped = Math.max(0, Math.min(100, Math.round(raw)));
      return { confidence: clamped, confidenceLabel: `${clamped}%` };
    }
    return DEFAULT_CONFIDENCE;
  }

  private classifyHeatSource(
    lat: number,
    lon: number,
    frp: number,
    cell: CompactCellStat | undefined,
    isMultiDayDataset: boolean
  ): OrigenCalor {
    // 1. Mar / offshore (derrames, plataformas y quemadores marinos)
    for (const z of OFFSHORE_MARINE_ZONES) {
      if (lat >= z.minLat && lat <= z.maxLat && lon >= z.minLon && lon <= z.maxLon) {
        return 'sea';
      }
    }

    // 2. Volcán activo: zonas volcánicas conocidas o anomalía recurrente de muy alta energía (FRP >= 120)
    for (const [vLat, vLon] of KNOWN_VOLCANOES) {
      if (Math.abs(lat - vLat) <= 0.18 && Math.abs(lon - vLon) <= 0.18) {
        return 'vol';
      }
    }
    const distinctDaysCount = cell ? (cell.days ? cell.days.size : 1) : 1;
    if (frp >= 120 && distinctDaysCount >= 2) {
      return 'vol';
    }

    // 3. Estático (fábricas / complejos industriales): >= 4 días distintos en celda 0.02° y baja dispersión de FRP
    const hits = cell ? cell.hits : 1;
    const meanFrp = cell && cell.hits > 0 ? cell.frpSum / cell.hits : frp;
    const variance = cell && cell.hits > 1 ? Math.max(0, cell.frpSqSum / cell.hits - meanFrp * meanFrp) : 0;
    const cv = Math.sqrt(variance) / Math.max(1, meanFrp);

    if (isMultiDayDataset) {
      if (distinctDaysCount >= 4 && cv <= 0.7) {
        return 'ind';
      }
    } else {
      if (hits >= 3 && cv <= 0.6 && meanFrp < 120) {
        return 'ind';
      }
      for (const [iLat, iLon] of KNOWN_INDUSTRIAL_ZONES) {
        if (Math.abs(lat - iLat) <= 0.15 && Math.abs(lon - iLon) <= 0.15 && frp < 120) {
          return 'ind';
        }
      }
    }

    // 4. Vegetación (incendios forestales y quemas agrícolas terrestres)
    return 'veg';
  }
}

export type SeveridadNivel = 1 | 2 | 3 | 4 | 5;

export type OrigenCalor = 'veg' | 'vol' | 'ind' | 'sea';

export type MapStyleKey = 'dark' | 'sat' | 'terrain';

export type MapProjectionType = 'globe' | 'mercator';

export type IdiomaCodigo = 'es' | 'en';

export interface RawIncendioRecord {
  latitude: string | number;
  longitude: string | number;
  scan: string | number;
  confidence: string | number;
  daynight: string;
  datetime: string;
  acq_date?: string;
  acq_time?: string | number;
  frp: string | number;
  sensor: string;
  frp_log?: string | number;
  scan_norm?: string | number;
  frp_log_norm?: string | number;
  country?: string;
}

export interface Incendio {
  id: string;
  latitude: number;
  longitude: number;
  scan: number;
  scanNorm: number;
  confidence: number;
  confidenceLabel: string;
  daynight: string;
  datetime: string;
  date: string;
  time: string;
  day: number;
  frp: number;
  frpLog: number;
  frpLogNorm: number;
  sensor: string;
  country: string;
  sev: SeveridadNivel;
  src: OrigenCalor;
}

export interface HotspotFeatureProperties {
  id: string;
  day: number;
  date: string;
  time: string;
  sev: SeveridadNivel;
  frp: number;
  frp_log_norm: number;
  scan: number;
  conf: number;
  confLabel: string;
  daynight: string;
  sensor: string;
  country: string;
  region: string;
  src: OrigenCalor;
}

export interface HotspotFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: HotspotFeatureProperties;
}

export interface HotspotFeatureCollection {
  type: 'FeatureCollection';
  features: HotspotFeature[];
}

export interface IncendiosQueryParams {
  fecha?: string;
  mesConsulta?: number;
  anioConsulta?: number;
  pais?: string;
  horaInicio?: string;
  horaFin?: string;
  limite?: number;
  north?: number;
  south?: number;
  east?: number;
  west?: number;
  lat?: number;
  lon?: number;
  radioKm?: number;
  formato?: 'json' | 'csv';
  compact?: 0 | 1;
}

export interface IncendiosApiResponse {
  filtrosAplicados: {
    fecha: string;
    mes: string;
    pais: string;
    bbox?: { north: number; south: number; east: number; west: number } | null;
    radio?: { lat: number; lon: number; radioKm: number } | null;
  };
  paisesIncluidos: number;
  totalRegistros: number;
  devueltos: number;
  truncado: boolean;
  compact?: boolean;
  columns?: string[];
  rows?: Array<Array<string | number>>;
  data?: RawIncendioRecord[];
}

export interface ResumenMesItem {
  mes: number;
  totalFocos: number;
  frpMax: number;
  frpAvg?: number;
  intensidadMaxima: string;
  nivelMaximo: number;
}

export interface ResumenDiaItem {
  dia: number;
  fecha: string;
  totalFocos: number;
  frpMax: number;
  intensidadMaxima: string;
  nivelMaximo: number;
}

export interface ResumenCalendario {
  anio: number;
  mes: number | null;
  pais: string;
  bbox?: { north: number; south: number; east: number; west: number } | null;
  parcial?: boolean;
  resumenMensual: ResumenMesItem[];
  resumenDiario?: ResumenDiaItem[];
  diaPico?: {
    dia: number;
    totalFocos: number;
  };
  intensidadMaximaMes?: string;
  nivelMaximoMes?: number;
  distribucionIntensidad?: Record<number, number>;
  medianaHistoricaMes?: number;
  promedioHistoricoMes?: number;
  aniosDisponiblesMediana?: number;
}

export interface HistorialAnioItem {
  anio: number;
  totalFocos: number;
  frpMax: number;
  frpAvg: number;
  nivelMaximo: number;
  mesPico: number;
  mesPicoFocos: number;
  meses: number[];
}

export interface HistorialMesEstacionalItem {
  mes: number;
  totalFocos: number;
  aniosConDatos: number;
  promedioAnual: number;
  medianaAnual: number;
  maxAnual: number;
  anioPico: number;
}

export interface HistorialTopAnioItem {
  anio: number;
  totalFocos: number;
  frpMax: number;
  frpAvg: number;
  mesPico: number;
  mesPicoFocos: number;
}

export interface HistorialAnualResponse {
  desdeAnio: number;
  hastaAnio: number;
  pais: string;
  bbox?: { north: number; south: number; east: number; west: number } | null;
  parcial: boolean;
  totalHistorico: number;
  aniosConDatos: number;
  promedioAnual: number;
  medianaAnual: number;
  anioPico: HistorialTopAnioItem | null;
  topAnios: HistorialTopAnioItem[];
  mesPicoEstacional: HistorialMesEstacionalItem | null;
  topMesesEstacionales: HistorialMesEstacionalItem[];
  porAnio: HistorialAnioItem[];
  porMes: HistorialMesEstacionalItem[];
}

export interface AreaFilterScope {
  name: string;
  pais?: string;
  bbox?: [number, number, number, number] | null;
  center?: [number, number];
  isCountry?: boolean;
}

export interface Filtros {
  severidades: Set<SeveridadNivel>;
  origenes: Set<OrigenCalor>;
  startDay: number;
  endDay: number;
}

export interface MapSettings {
  style: MapStyleKey;
  projection: MapProjectionType;
  heat: boolean;
  borders: boolean;
  alerts: boolean;
  warn: boolean;
  pred: boolean;
  glass: boolean;
  size: number;
  opacity: number;
  spin: boolean;
}

export interface AlertHotspot {
  id: string;
  sev: SeveridadNivel;
  frp: number;
  country: string;
  coordinates: [number, number];
  datetime: string;
  sensor: string;
}

export interface RiskInputs {
  T: number;
  H: number;
  V: number;
  D: number;
  S: number;
  F?: number;
  lat?: number;
  lng?: number;
}

export interface RiskTerm {
  label: string;
  value: number;
}

export interface RiskOutput {
  score: number;
  terms: RiskTerm[];
}

export interface GeocodeFeature {
  id?: string;
  text: string;
  place_name: string;
  center: [number, number];
  bbox?: [number, number, number, number];
  place_type?: string[];
  properties?: { short_code?: string };
  context?: Array<{ id: string; text: string; short_code?: string }>;
}

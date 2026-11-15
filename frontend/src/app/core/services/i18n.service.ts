import { Injectable, computed, signal } from '@angular/core';
import { IdiomaCodigo, OrigenCalor } from '../models';

const EN_DICT: Record<string, string> = {
  'Mapa global de focos de calor': 'Global hotspot map',
  'Logo de IRIS': 'IRIS logo',
  'Recibir focos nuevos en tiempo real': 'Receive new hotspots in real time',
  'Mostrar focos nuevos en el mapa': 'Show new hotspots on the map',
  'Línea del tiempo': 'Timeline',
  'Predicción de riesgo (experimental)': 'Risk prediction (experimental)',
  'Predicción': 'Prediction',
  'Lenguaje': 'Language',
  'En vivo': 'Live',
  'Nuevo ⚠️': 'New ⚠️',
  'Lugar o coordenadas (19.04, -98.2)': 'Place or coordinates (19.04, -98.2)',
  'Buscar lugar o coordenadas': 'Search place or coordinates',
  'Buscar': 'Search',
  'Acercar': 'Zoom in',
  'Alejar': 'Zoom out',
  'Tipo de vista': 'View type',
  'Globo': 'Globe',
  'Mapa': 'Map',
  'Ajustes': 'Settings',
  'Filtros': 'Filters',
  'Token de Mapbox': 'Mapbox token',
  'Predicción experimental': 'Experimental prediction',
  'Cerrar': 'Close',
  'Quitar zona': 'Remove area',
  'Estilo base': 'Base style',
  'Oscuro': 'Dark',
  'Satélite': 'Satellite',
  'Terreno': 'Terrain',
  'Manchas de calor (en vez de puntos)': 'Heat blobs (instead of dots)',
  'Resaltar fronteras y costas': 'Highlight borders and coastlines',
  'Avisos de focos nuevos': 'New hotspot alerts',
  'Focos': 'Hotspots',
  'Tamaño': 'Size',
  'Opacidad': 'Opacity',
  'Movimiento': 'Motion',
  'Rotación automática del globo': 'Auto-rotate globe',
  'Guardar': 'Save',
  'Al guardar, la página se recarga con el nuevo token.': 'Saving reloads the page with the new token.',
  'Restablecer vista': 'Reset view',
  'Elige un año y un mes. Si quieres, también un día.': 'Pick a year and a month. Optionally, a day too.',
  '🕒 Línea del tiempo': '🕒 Timeline',
  '▶ Reproducir mes': '▶ Play month',
  '⏸ Pausar': '⏸ Pause',
  '🔥 Ir al foco más intenso': '🔥 Go to strongest hotspot',
  '✕ Volver a hoy': '✕ Back to today',
  '1 · Año': '1 · Year',
  '2 · Mes': '2 · Month',
  '3 · Día': '3 · Day',
  '(opcional)': '(optional)',
  'Todo el mes': 'Whole month',
  '🔮 Predicción de riesgo': '🔮 Risk prediction',
  'Calcula el riesgo de incendio en la zona del centro del mapa. Combina variables meteorológicas locales con focos activos cercanos de NASA FIRMS.': 'Estimates fire risk for the area at the center of the map. Combines local meteorological variables with nearby active hotspots from NASA FIRMS.',
  'Calcular aquí': 'Calculate here',
  'Quitar del mapa': 'Remove from map',
  'Ver la ecuación': 'View the equation',
  'T temperatura · H humedad · V viento · D días sin lluvia · S vegetación seca · F focos cercanos': 'T temperature · H humidity · V wind · D days without rain · S dry vegetation · F nearby hotspots',
  'Reproducción terminada': 'Playback finished',
  '¿Te gustaría ver el listado más detallado de los incendios de este mes?': "Would you like to see the detailed list of this month's fires?",
  'No, gracias': 'No, thanks',
  'Sí, ver listado': 'Yes, show list',
  '📋 Listado de incendios': '📋 Fire list',
  'Día': 'Day',
  '© 2026 IRIS · Datos armonizados MODIS + VIIRS · NASA FIRMS': '© 2026 IRIS · Harmonized MODIS + VIIRS data · NASA FIRMS',
  'Mapas © Mapbox · © OpenStreetMap · NASA FIRMS': 'Maps © Mapbox · © OpenStreetMap · NASA FIRMS',
  'Coordenadas': 'Coordinates',
  'Términos y condiciones': 'Terms and conditions',
  'Conecta tu mapa': 'Connect your map',
  'IRIS usa Mapbox para dibujar el globo. Pega tu token público (empieza con': 'IRIS uses Mapbox to draw the globe. Paste your public token (starts with',
  ') para continuar. Se guarda solo en este navegador.': ') to continue. It is saved only in this browser.',
  'Obtener un token en Mapbox': 'Get a token from Mapbox',
  'Guardar y abrir el mapa': 'Save and open the map',
  'Temperatura': 'Temperature',
  'Humedad del aire': 'Air humidity',
  'Viento': 'Wind',
  'Días sin lluvia': 'Days without rain',
  'Vegetación seca': 'Dry vegetation',
  'Aire seco': 'Dry air',
  'Focos cercanos': 'Nearby hotspots',
  'días': 'days',
  'Fecha': 'Date',
  'Hora (UTC)': 'Time (UTC)',
  'Lugar': 'Place',
  'Latitud': 'Latitude',
  'Longitud': 'Longitude',
  'Intensidad': 'Intensity',
  'Tipo': 'Type',
  'Entendido': 'Got it',
  'Apariencia': 'Appearance',
  'Efecto liquid glass': 'Liquid glass effect',
  'Año anterior': 'Previous year',
  'Año siguiente': 'Next year',
  'Elegir año': 'Pick a year',
  'Elegir un día (opcional)': 'Pick a day (optional)',
  'Más opciones': 'More options',
  '📋 Ver listado': '📋 View list',
  '✕ Cerrar sección': '✕ Close section',
  'Descargar análisis de actividad': 'Download activity analysis',
  'Desde': 'From',
  'Hasta': 'To',
  'Últimos 7 días': 'Last 7 days',
  'Últimos 30 días': 'Last 30 days',
  'Últimos 90 días': 'Last 90 days',
  'Último año': 'Last year',
  'Reporte con gráficas (.html)': 'Report with charts (.html)',
  'Región seleccionada': 'Selected region',
  'Silenciar música': 'Mute music',
  'Activar música': 'Turn music on',
  'Descargar': 'Download'
};

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly lang = signal<IdiomaCodigo>(this.detectInitialLang());

  readonly locale = computed(() => (this.lang() === 'en' ? 'en-US' : 'es-MX'));

  readonly sevNames = computed<string[]>(() =>
    this.lang() === 'en'
      ? ['', 'Low', 'Moderate', 'High', 'Critical', 'Extreme']
      : ['', 'Bajo', 'Moderado', 'Alto', 'Crítico', 'Extremo']
  );

  readonly meses = computed<string[]>(() =>
    this.lang() === 'en'
      ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      : ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  );

  readonly srcNames = computed<Record<OrigenCalor, string>>(() =>
    this.lang() === 'en'
      ? { veg: 'Vegetation', vol: 'Active volcano', ind: 'Static (factories)', sea: 'Sea (oil spill)' }
      : { veg: 'Vegetación', vol: 'Volcán activo', ind: 'Estático (fábricas)', sea: 'Mar (derrame de petróleo)' }
  );

  readonly srcLabels = computed<Record<OrigenCalor, string>>(() =>
    this.lang() === 'en'
      ? { veg: '🌲 Vegetation', vol: '🌋 Active volcano', ind: '🏭 Static (factories)', sea: '🛢️ Sea (oil spill)' }
      : { veg: '🌲 Vegetación', vol: '🌋 Volcán activo', ind: '🏭 Estático (fábricas)', sea: '🛢️ Mar (derrame de petróleo)' }
  );

  readonly cols = computed<string[]>(() => [
    this.translate('Fecha'),
    this.translate('Hora (UTC)'),
    this.translate('Lugar'),
    this.translate('Latitud'),
    this.translate('Longitud'),
    this.translate('Intensidad'),
    this.translate('Tipo'),
    'FRP (MW)',
    'Sensor'
  ]);

  constructor() {
    this.applyDocumentLang(this.lang());
  }

  private detectInitialLang(): IdiomaCodigo {
    try {
      const saved = localStorage.getItem('iris_lang');
      if (saved === 'es' || saved === 'en') return saved;
    } catch {
      // ignore storage errors
    }
    return 'en';
  }

  setLang(l: IdiomaCodigo): void {
    this.lang.set(l);
    try {
      localStorage.setItem('iris_lang', l);
    } catch {
      // ignore storage errors
    }
    this.applyDocumentLang(l);
  }

  private applyDocumentLang(l: IdiomaCodigo): void {
    document.documentElement.lang = l;
    document.documentElement.dataset['lang'] = l;
  }

  l(es: string, en: string): string {
    return this.lang() === 'en' ? en : es;
  }

  translate(key: string): string {
    if (this.lang() === 'en' && Object.prototype.hasOwnProperty.call(EN_DICT, key)) {
      return EN_DICT[key];
    }
    return key;
  }

  unit(u: string): string {
    return u === ' días' ? ' ' + this.translate('días') : u;
  }

  dayLabel(monthIdx: number, day: number): string {
    const mes = this.meses()[monthIdx] ?? '';
    return this.lang() === 'en' ? `${mes} ${day}` : `${day} de ${mes}`;
  }
}

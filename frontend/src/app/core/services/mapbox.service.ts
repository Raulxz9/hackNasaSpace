import { Injectable, NgZone, inject, signal } from '@angular/core';
import mapboxgl, { LngLatLike, Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';
import { environment } from '../../../environments/environment';
import {
  Filtros,
  GeocodeFeature,
  HotspotFeature,
  HotspotFeatureCollection,
  MapProjectionType,
  MapSettings,
  MapStyleKey,
  SeveridadNivel
} from '../models';
import { I18nService } from './i18n.service';

export interface ToastNotice {
  message: string;
  isError?: boolean;
  flyTo?: [number, number];
}

const SEV_COLORS: Record<SeveridadNivel, string> = {
  1: '#FACC15',
  2: '#FB923C',
  3: '#EF4444',
  4: '#B91C1C',
  5: '#7F1D1D'
};

@Injectable({ providedIn: 'root' })
export class MapboxService {
  private readonly ngZone = inject(NgZone);
  private readonly i18n = inject(I18nService);

  private map: MapboxMap | null = null;
  private token = '';
  private hotspotsData: HotspotFeatureCollection = { type: 'FeatureCollection', features: [] };
  private sourceHotspotsRef: HotspotFeatureCollection | null = null;
  private riskData: { type: 'FeatureCollection'; features: unknown[] } = { type: 'FeatureCollection', features: [] };
  private areaGeoJson: { type: 'FeatureCollection'; features: unknown[] } = { type: 'FeatureCollection', features: [] };
  private areaMarker: mapboxgl.Marker | null = null;
  private peakMarker: mapboxgl.Marker | null = null;
  private meMarker: mapboxgl.Marker | null = null;

  private spinTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private popup: mapboxgl.Popup | null = null;
  private pinned = false;
  private interacting = false;
  private pauseUntil = 0;
  private ptrPoint: { x: number; y: number } | null = null;
  private readonly geoCache: Record<string, string> = {};

  private readonly typesHierarchy = ['country', 'region', 'district', 'place', 'locality', 'neighborhood'];
  private drillState: { level: number; bbox: [number, number, number, number] | null; busy: boolean; hintShown: boolean } = {
    level: -1,
    bbox: null,
    busy: false,
    hintShown: false
  };

  private currentSettings: MapSettings = {
    style: 'terrain',
    projection: 'globe',
    heat: true,
    borders: true,
    alerts: true,
    warn: false,
    pred: false,
    glass: true,
    size: 1,
    opacity: 0.95,
    spin: true
  };

  private currentFilters: Filtros = {
    severidades: new Set<SeveridadNivel>([1, 2, 3, 4, 5]),
    origenes: new Set(['veg', 'vol', 'ind', 'sea']),
    startDay: 0,
    endDay: 999999
  };

  private warnMinDay = 0;

  readonly cursorCoords = signal<string>('—');
  readonly areaName = signal<string>('');
  readonly tokenError = signal<boolean>(false);
  readonly mapReady = signal<boolean>(false);

  private onToastCallback: ((n: ToastNotice) => void) | null = null;
  private onSpinChangeCallback: ((spinning: boolean) => void) | null = null;

  registerCallbacks(
    onToast: (n: ToastNotice) => void,
    onSpinChange: (spinning: boolean) => void
  ): void {
    this.onToastCallback = onToast;
    this.onSpinChangeCallback = onSpinChange;
  }

  private emitToast(n: ToastNotice): void {
    this.ngZone.run(() => this.onToastCallback?.(n));
  }

  getMap(): MapboxMap | null {
    return this.map;
  }

  getCenter(): { lng: number; lat: number } | null {
    if (!this.map) return null;
    const c = this.map.getCenter();
    return { lng: c.lng, lat: c.lat };
  }

  initMap(
    container: HTMLElement,
    token: string,
    settings: MapSettings,
    filters: Filtros,
    warnMinDay: number
  ): void {
    this.destroy();
    this.token = token;
    this.currentSettings = { ...settings };
    this.currentFilters = {
      severidades: new Set(filters.severidades),
      origenes: new Set(filters.origenes),
      startDay: filters.startDay,
      endDay: filters.endDay
    };
    this.warnMinDay = warnMinDay;
    this.tokenError.set(false);

    try {
      const mb = mapboxgl as unknown as { accessToken: string; workerUrl: string };
      mb.accessToken = token;
      // Usa el worker precompilado oficial para evitar el error _asyncToGenerator de Babel/Vite en Blob Workers
      mb.workerUrl = new URL('assets/mapbox-gl-csp-worker.js', document.baseURI).toString();
    } catch {
      // ignore if read-only in ESM namespace
    }

    this.ngZone.runOutsideAngular(() => {
      const m = new mapboxgl.Map({
        container,
        accessToken: token,
        style: environment.mapboxStyles[settings.style],
        projection: settings.projection,
        center: environment.defaultView.center,
        zoom: environment.defaultView.zoom,
        attributionControl: false
      });

      this.map = m;
      m.addControl(new mapboxgl.AttributionControl({ compact: true }), 'top-right');

      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          this.map?.resize();
        });
        this.resizeObserver.observe(container);
      }
      requestAnimationFrame(() => this.map?.resize());
      m.on('load', () => {
        m.resize();
        this.applyFilters(this.currentFilters, this.warnMinDay);
      });

      m.on('style.load', () => {
        m.setProjection(this.currentSettings.projection);
        this.setFog();
        this.addSatEsri();
        this.addDataLayers();
        this.styleBase();
        this.applyMapLang();
        this.applyFilters(this.currentFilters, this.warnMinDay);
        this.ngZone.run(() => this.mapReady.set(true));
        this.scheduleSpin();
      });

      m.on('error', (e) => {
        const status = (e.error as { status?: number } | undefined)?.status;
        if (status === 401 || status === 403) {
          this.ngZone.run(() => this.tokenError.set(true));
          this.emitToast({
            message: this.i18n.l(
              'El token de Mapbox no es válido. Revisa que empiece con pk.',
              'The Mapbox token is not valid. Check that it starts with pk.'
            ),
            isError: true
          });
        }
      });

      ['dragstart', 'zoomstart', 'pitchstart', 'rotatestart'].forEach((ev) =>
        m.on(ev, (e: { originalEvent?: unknown }) => {
          if (e.originalEvent) this.interacting = true;
        })
      );

      ['dragend', 'zoomend', 'pitchend', 'rotateend'].forEach((ev) =>
        m.on(ev, (e: { originalEvent?: unknown }) => {
          this.interacting = false;
          if (e.originalEvent) this.pauseUntil = Date.now() + 4000;
          this.scheduleSpin();
        })
      );

      m.on('moveend', () => this.scheduleSpin());
      m.on('mousemove', (e: MapMouseEvent) => {
        this.ptrPoint = e.point;
        this.updateCursorCoords();
      });
      m.on('click', (e: MapMouseEvent) => {
        this.ptrPoint = e.point;
        this.updateCursorCoords();
      });
      m.on('move', () => {
        if (this.ptrPoint) this.updateCursorCoords();
      });
      m.getCanvas().addEventListener('mouseleave', () => {
        this.ptrPoint = null;
        this.updateCursorCoords();
      });

      m.on('mouseenter', 'hs-core', (e: MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
        m.getCanvas().style.cursor = 'pointer';
        if (this.pinned || !e.features?.length) return;
        this.interacting = true;
        m.stop();
        this.showPopup(e.features[0], e.lngLat, false);
      });

      m.on('mouseleave', 'hs-core', () => {
        m.getCanvas().style.cursor = '';
        if (this.pinned) return;
        if (this.popup) {
          this.popup.remove();
          this.popup = null;
        }
        this.interacting = false;
        this.scheduleSpin();
      });

      m.on('click', 'hs-core', (e: MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
        if (!e.features?.length) return;
        this.stopSpin();
        this.showPopup(e.features[0], e.lngLat, true);
      });

      m.on('click', (e: MapMouseEvent) => {
        const layers = ['hs-core', 'warn'].filter((id) => m.getLayer(id));
        if (layers.length && m.queryRenderedFeatures(e.point, { layers }).length) return;
        void this.drill(e.lngLat);
      });

      m.on('click', 'warn', (e: MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
        const coords = (e.features?.[0]?.geometry as GeoJSON.Point | undefined)?.coordinates;
        if (!coords) return;
        this.stopSpin();
        m.flyTo({ center: [coords[0], coords[1]], zoom: 6, duration: 2200 });
      });
    });
  }

  destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.spinTimer) {
      clearTimeout(this.spinTimer);
      this.spinTimer = null;
    }
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    if (this.areaMarker) {
      this.areaMarker.remove();
      this.areaMarker = null;
    }
    this.clearPeakMarker();
    if (this.meMarker) {
      this.meMarker.remove();
      this.meMarker = null;
    }
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.sourceHotspotsRef = null;
    this.mapReady.set(false);
  }

  setHotspotsData(data: HotspotFeatureCollection, warnMinDay?: number): void {
    const isSameRef = this.hotspotsData === data;
    this.hotspotsData = data;
    if (warnMinDay !== undefined) {
      this.warnMinDay = warnMinDay;
    }
    if (this.map && this.map.getSource('hotspots')) {
      if (!isSameRef || this.sourceHotspotsRef !== data) {
        (this.map.getSource('hotspots') as mapboxgl.GeoJSONSource).setData(
          data as unknown as GeoJSON.FeatureCollection
        );
        this.sourceHotspotsRef = data;
      }
      this.applyFilters(this.currentFilters, this.warnMinDay);
    }
  }

  setRiskData(features: unknown[]): void {
    this.riskData = { type: 'FeatureCollection', features };
    if (this.map && this.map.getSource('risk')) {
      (this.map.getSource('risk') as mapboxgl.GeoJSONSource).setData(
        this.riskData as unknown as GeoJSON.FeatureCollection
      );
    }
  }

  updateSettings(settings: MapSettings): void {
    const styleChanged = settings.style !== this.currentSettings.style;
    const projChanged = settings.projection !== this.currentSettings.projection;
    const spinChanged = settings.spin !== this.currentSettings.spin;
    this.currentSettings = { ...settings };

    if (!this.map) return;
    if (styleChanged) {
      this.map.setStyle(environment.mapboxStyles[settings.style], { diff: false } as Parameters<MapboxMap['setStyle']>[1]);
      return;
    }
    if (projChanged) {
      this.map.setProjection(settings.projection);
      if (settings.projection === 'globe') {
        this.scheduleSpin();
      } else {
        this.map.stop();
      }
    }
    if (spinChanged) {
      if (settings.spin) {
        this.scheduleSpin();
      } else {
        if (this.spinTimer) clearTimeout(this.spinTimer);
        this.map.stop();
      }
    }
    this.setLayerVisibility();
  }

  applyFilters(filters: Filtros, warnMinDay?: number): void {
    this.currentFilters = {
      severidades: new Set(filters.severidades),
      origenes: new Set(filters.origenes),
      startDay: filters.startDay,
      endDay: filters.endDay
    };
    if (warnMinDay !== undefined) {
      this.warnMinDay = warnMinDay;
    }
    if (!this.map) return;

    // No bloquear por isStyleLoaded(): mientras el globo gira o descarga tiles base, isStyleLoaded() puede ser false y descartaría el filtro de fecha
    const f = this.currentFilterExpr();
    ['heat', 'hs-glow', 'hs-core'].forEach((id) => {
      if (this.map?.getLayer(id)) {
        try {
          this.map.setFilter(id, f);
        } catch {
          // ignore if style is mid-transition
        }
      }
    });
    if (this.map.getLayer('warn')) {
      try {
        this.map.setFilter('warn', this.warnFilterExpr());
      } catch {
        // ignore if style is mid-transition
      }
    }
    this.map.triggerRepaint();
  }

  zoomIn(): void {
    this.map?.zoomIn();
  }

  zoomOut(): void {
    this.map?.zoomOut();
  }

  setProjection(projection: MapProjectionType): void {
    this.currentSettings.projection = projection;
    if (!this.map) return;
    this.map.setProjection(projection);
    if (projection === 'globe') {
      this.scheduleSpin();
    } else {
      this.map.stop();
    }
  }

  flyTo(center: [number, number], zoom = 6, duration = 2200): void {
    if (!this.map) return;
    this.stopSpin();
    this.map.flyTo({ center, zoom, duration });
  }

  resetView(): void {
    if (!this.map) return;
    this.map.flyTo({
      center: environment.defaultView.center,
      zoom: environment.defaultView.zoom,
      pitch: 0,
      bearing: 0,
      duration: 1800
    });
    this.setFog();
  }

  applyMapLang(): void {
    if (!this.map || !this.map.isStyleLoaded()) return;
    const lang = this.i18n.lang();
    try {
      this.map.getStyle().layers?.forEach((layer) => {
        if (layer.type !== 'symbol') return;
        const tf = this.map?.getLayoutProperty(layer.id, 'text-field');
        if (!tf || !/name/.test(JSON.stringify(tf))) return;
        this.map?.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name_' + lang], ['get', 'name']]);
      });
    } catch {
      // ignore style layer incompatibilities
    }
  }

  async geocode(query: string, autocomplete: boolean, limit: number): Promise<GeocodeFeature[]> {
    if (!this.map || !this.token) return [];
    const c = this.map.getCenter();
    const px = this.map.getZoom() > 4 ? `&proximity=${c.lng.toFixed(3)},${c.lat.toFixed(3)}` : '';
    const lang = this.i18n.lang();
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=${limit}&language=${lang}&fuzzyMatch=true&autocomplete=${autocomplete}${px}&access_token=${this.token}`;
    const res = await fetch(url);
    const json = await res.json();
    return (json.features || []) as GeocodeFeature[];
  }

  goToFeature(feature: GeocodeFeature): void {
    if (!this.map) return;
    this.stopSpin();
    const type = (feature.place_type || [])[0];
    const fine = type === 'address' || type === 'poi';
    const typeIdx = this.typesHierarchy.indexOf(type);
    this.drillState.level = typeIdx >= 0 ? typeIdx : fine ? this.typesHierarchy.length : 2;
    this.drillState.bbox = feature.bbox || null;

    if (fine) {
      this.map.flyTo({ center: feature.center, zoom: 17, pitch: 0, duration: 2400 });
    } else if (feature.bbox) {
      this.map.fitBounds(feature.bbox, { padding: 90, duration: 2400, maxZoom: type === 'neighborhood' ? 16 : 13 });
    } else {
      this.map.flyTo({ center: feature.center, zoom: 13, duration: 2400 });
    }
    void this.showArea(feature, fine);
  }

  clearArea(): void {
    this.setArea({ type: 'FeatureCollection', features: [] }, '');
    if (this.areaMarker) {
      this.areaMarker.remove();
      this.areaMarker = null;
    }
    this.drillState.level = -1;
    this.drillState.bbox = null;
  }

  getAreaBox(): [number, number, number, number] | null {
    if (this.drillState.bbox) return this.drillState.bbox;
    const first = this.areaGeoJson.features[0] as { geometry?: { coordinates?: unknown } } | undefined;
    if (!first?.geometry?.coordinates) return null;
    let w = 180;
    let s = 90;
    let e = -180;
    let n = -90;
    const walk = (c: unknown): void => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        w = Math.min(w, c[0]);
        e = Math.max(e, c[0]);
        s = Math.min(s, c[1]);
        n = Math.max(n, c[1]);
        return;
      }
      c.forEach(walk);
    };
    walk(first.geometry.coordinates);
    return w <= e && s <= n ? [w, s, e, n] : null;
  }

  isPointInArea(lng: number, lat: number, box: [number, number, number, number]): boolean {
    if (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3]) return false;
    const first = this.areaGeoJson.features[0] as { geometry?: { type: string; coordinates: unknown } } | undefined;
    return first?.geometry ? this.geomIn(first.geometry, lng, lat) : true;
  }

  locateMe(): void {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!this.map) return;
        const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        const el = document.createElement('div');
        el.className = 'me';
        if (this.meMarker) this.meMarker.remove();
        this.meMarker = new mapboxgl.Marker({ element: el }).setLngLat(c).addTo(this.map);
        this.pauseUntil = Date.now() + 8000;
        this.map.stop();
        this.map.flyTo({ center: c, zoom: 9, duration: 3200, essential: true });
        this.emitToast({
          message: this.i18n.l('Mostrando tu ubicación.', 'Showing your location.')
        });
      },
      () => {
        // ignore denied/unavailable geolocation
      },
      { timeout: 20000, maximumAge: 600000 }
    );
  }

  clearPeakMarker(): void {
    if (this.peakMarker) {
      this.peakMarker.remove();
      this.peakMarker = null;
    }
  }

  focusPeakHotspot(feature: HotspotFeature): void {
    if (!this.map) return;
    this.stopSpin();
    this.clearPeakMarker();
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    const coords: [number, number] = [feature.geometry.coordinates[0], feature.geometry.coordinates[1]];
    let shown = false;
    const show = () => {
      if (shown || !this.map) return;
      shown = true;
      const el = document.createElement('div');
      el.className = 'peak';
      el.style.setProperty('--c', SEV_COLORS[feature.properties.sev]);
      el.innerHTML = '<i></i>';
      this.peakMarker = new mapboxgl.Marker({ element: el }).setLngLat(coords).addTo(this.map);
      this.showPopup(
        feature as unknown as mapboxgl.GeoJSONFeature,
        { lng: coords[0], lat: coords[1] } as mapboxgl.LngLat,
        true
      );
      this.popup?.on('close', () => this.clearPeakMarker());
    };
    this.map.flyTo({ center: coords, zoom: 8, duration: 2200, essential: true });
    this.map.once('moveend', () => {
      if (!this.map) return;
      const cc = this.map.getCenter();
      if (Math.hypot(cc.lng - coords[0], cc.lat - coords[1]) < 0.5) show();
    });
    setTimeout(show, 2700);
  }

  stopSpin(): void {
    this.currentSettings.spin = false;
    if (this.spinTimer) clearTimeout(this.spinTimer);
    this.map?.stop();
    this.ngZone.run(() => this.onSpinChangeCallback?.(false));
  }

  private scheduleSpin(): void {
    if (
      !this.map ||
      !this.currentSettings.spin ||
      this.interacting ||
      this.currentSettings.projection !== 'globe' ||
      this.map.getZoom() > environment.spinMaxZoom
    ) {
      return;
    }
    const wait = this.pauseUntil - Date.now();
    if (wait > 0) {
      if (this.spinTimer) clearTimeout(this.spinTimer);
      this.spinTimer = setTimeout(() => this.scheduleSpin(), wait + 30);
      return;
    }
    const c = this.map.getCenter();
    c.lng -= environment.spinDegPerSec;
    this.map.easeTo({ center: c, duration: 1000, easing: (n) => n });
  }

  private updateCursorCoords(): void {
    if (!this.map || !this.ptrPoint) {
      this.ngZone.run(() => this.cursorCoords.set('—'));
      return;
    }
    const ll = this.map.unproject([this.ptrPoint.x, this.ptrPoint.y]);
    const q = this.map.project(ll);
    if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng) || Math.hypot(q.x - this.ptrPoint.x, q.y - this.ptrPoint.y) > 4) {
      this.ngZone.run(() => this.cursorCoords.set('—'));
      return;
    }
    const normalizedLng = (((ll.lng + 540) % 360) - 180).toFixed(4);
    this.ngZone.run(() => this.cursorCoords.set(`${ll.lat.toFixed(4)}, ${normalizedLng}`));
  }

  private currentFilterExpr(): mapboxgl.FilterSpecification {
    return [
      'all',
      ['>=', ['get', 'day'], this.currentFilters.startDay],
      ['<=', ['get', 'day'], this.currentFilters.endDay],
      ['in', ['get', 'sev'], ['literal', [...this.currentFilters.severidades]]],
      ['in', ['get', 'src'], ['literal', [...this.currentFilters.origenes]]]
    ] as unknown as mapboxgl.FilterSpecification;
  }

  private warnFilterExpr(): mapboxgl.FilterSpecification {
    return [
      'all',
      ['>=', ['get', 'day'], this.warnMinDay],
      ['in', ['get', 'sev'], ['literal', [...this.currentFilters.severidades]]],
      ['in', ['get', 'src'], ['literal', [...this.currentFilters.origenes]]]
    ] as unknown as mapboxgl.FilterSpecification;
  }

  private heatRadiusExpr(scale: number): mapboxgl.ExpressionSpecification {
    return ['interpolate', ['linear'], ['zoom'], 0, 3 * scale, 3, 5 * scale, 6, 14 * scale, 9, 28 * scale];
  }

  private radiusExpr(multiplier: number): mapboxgl.ExpressionSpecification {
    return [
      'interpolate',
      ['linear'],
      ['zoom'],
      0,
      ['*', multiplier, ['+', 1.2, ['*', 0.45, ['get', 'sev']]]],
      4,
      ['*', multiplier, ['+', 2.5, ['*', 0.9, ['get', 'sev']]]],
      10,
      ['*', multiplier, ['+', 7, ['*', 2, ['get', 'sev']]]]
    ];
  }

  private sevMatchExpr(): mapboxgl.ExpressionSpecification {
    return [
      'match',
      ['get', 'sev'],
      1,
      SEV_COLORS[1],
      2,
      SEV_COLORS[2],
      3,
      SEV_COLORS[3],
      4,
      SEV_COLORS[4],
      5,
      SEV_COLORS[5],
      SEV_COLORS[1]
    ];
  }

  private createWarnImage(): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '46px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚠️', 32, 34);
    return ctx.getImageData(0, 0, 64, 64);
  }

  private addBase(): void {
    const m = this.map!;
    const s = this.currentSettings.style;
    if (!m.getSource('area')) {
      m.addSource('area', { type: 'geojson', data: this.areaGeoJson as unknown as GeoJSON.FeatureCollection });
    }
    try {
      if (!m.getSource('cb')) {
        m.addSource('cb', { type: 'vector', url: 'mapbox://mapbox.country-boundaries-v1' });
      }
      m.addLayer({
        id: 'iris-borders',
        type: 'line',
        source: 'cb',
        'source-layer': 'country_boundaries',
        filter: ['any', ['==', 'all', ['get', 'worldview']], ['in', 'US', ['get', 'worldview']]],
        layout: { visibility: this.currentSettings.borders ? 'visible' : 'none' },
        paint: {
          'line-color': s === 'dark' ? '#8FB4E8' : s === 'terrain' ? '#5a4a40' : '#c8ccd0',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            0,
            s === 'terrain' ? 0.6 : s === 'sat' ? 0.4 : 1,
            5,
            s === 'terrain' ? 1.1 : s === 'sat' ? 0.8 : 1.8
          ],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, s === 'terrain' ? 0.45 : s === 'sat' ? 0.4 : 0.9, 6.5, 0]
        }
      });
    } catch {
      // ignore vector boundary error if style lacks access
    }

    try {
      if (!m.getSource('mbs')) {
        m.addSource('mbs', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
      }
      m.addLayer({
        id: 'iris-admin1',
        type: 'line',
        source: 'mbs',
        'source-layer': 'admin',
        minzoom: 1.8,
        filter: [
          'all',
          ['==', ['get', 'admin_level'], 1],
          ['==', ['get', 'maritime'], 'false'],
          ['any', ['!', ['has', 'worldview']], ['==', 'all', ['get', 'worldview']], ['in', 'US', ['get', 'worldview']]]
        ],
        layout: { visibility: this.currentSettings.borders ? 'visible' : 'none', 'line-join': 'round' },
        paint: {
          'line-color': s === 'dark' ? '#7C93BF' : s === 'terrain' ? '#5a4a40' : '#c8ccd0',
          'line-width':
            s === 'sat'
              ? ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.7, 10, 1.2]
              : ['interpolate', ['linear'], ['zoom'], 2, 0.5, 6, 1.2, 10, 2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 2, s === 'sat' ? 0.2 : 0.3, 4, s === 'terrain' ? 0.5 : s === 'sat' ? 0.4 : 0.7]
        }
      });
    } catch {
      // ignore admin1 vector error
    }

    m.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#22D3EE', 'fill-opacity': 0.14 } });
    m.addLayer({ id: 'area-glow', type: 'line', source: 'area', paint: { 'line-color': '#22D3EE', 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.55 } });
    m.addLayer({ id: 'area-line', type: 'line', source: 'area', layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2.2 } });
  }

  private addDataLayers(): void {
    const m = this.map!;
    if (!m.getSource('risk')) {
      m.addSource('risk', { type: 'geojson', data: this.riskData as unknown as GeoJSON.FeatureCollection });
    }
    this.addBase();
    if (!m.getSource('hotspots')) {
      m.addSource('hotspots', { type: 'geojson', data: this.hotspotsData as unknown as GeoJSON.FeatureCollection });
      this.sourceHotspotsRef = this.hotspotsData;
    }

    m.addLayer({
      id: 'pred',
      type: 'circle',
      source: 'risk',
      layout: { visibility: this.currentSettings.pred ? 'visible' : 'none' },
      paint: {
        'circle-color': '#A78BFA',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 16, 5, 60, 9, 140],
        'circle-blur': 0.9,
        'circle-opacity': ['*', 0.5, ['get', 'risk']]
      }
    });

    m.addLayer({
      id: 'heat',
      type: 'heatmap',
      source: 'hotspots',
      filter: this.currentFilterExpr(),
      layout: { visibility: this.currentSettings.heat ? 'visible' : 'none' },
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'sev'], 1, 0.15, 5, 0.8],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 3, 0.8, 6, 1.6],
        'heatmap-radius': this.heatRadiusExpr(1),
        'heatmap-opacity': 0.8,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(11,18,32,0)',
          0.25,
          'rgba(250,204,21,0.3)',
          0.5,
          SEV_COLORS[2],
          0.78,
          SEV_COLORS[3],
          1,
          SEV_COLORS[4]
        ]
      }
    });

    m.addLayer({
      id: 'hs-glow',
      type: 'circle',
      source: 'hotspots',
      filter: this.currentFilterExpr(),
      layout: { visibility: !this.currentSettings.heat ? 'visible' : 'none' },
      paint: {
        'circle-color': this.sevMatchExpr(),
        'circle-radius': this.radiusExpr(this.currentSettings.size * 2.6),
        'circle-blur': 1,
        'circle-opacity': 0.2 * this.currentSettings.opacity
      }
    });

    m.addLayer({
      id: 'hs-core',
      type: 'circle',
      source: 'hotspots',
      filter: this.currentFilterExpr(),
      layout: { visibility: 'visible' },
      paint: {
        'circle-color': this.sevMatchExpr(),
        'circle-radius': this.radiusExpr(this.currentSettings.size),
        'circle-opacity': this.currentSettings.opacity,
        'circle-stroke-color': ['case', ['==', ['get', 'sev'], 5], '#FF3B30', '#0B1220'],
        'circle-stroke-width': ['case', ['==', ['get', 'sev'], 5], 1.6, 0.8]
      }
    });

    if (!m.hasImage('warn')) {
      m.addImage('warn', this.createWarnImage(), { pixelRatio: 2 });
    }
    m.addLayer({
      id: 'warn',
      type: 'symbol',
      source: 'hotspots',
      filter: this.warnFilterExpr(),
      layout: {
        visibility: this.currentSettings.warn ? 'visible' : 'none',
        'icon-image': 'warn',
        'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 5, 0.7, 10, 1]
      }
    });

    this.setLayerVisibility();
  }

  private setLayerVisibility(): void {
    if (!this.map) return;
    const setVis = (id: string, visible: boolean) => {
      if (this.map?.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    };
    setVis('hs-glow', !this.currentSettings.heat);
    setVis('hs-core', true);
    setVis('heat', this.currentSettings.heat);
    setVis('pred', this.currentSettings.pred);
    setVis('warn', this.currentSettings.warn);
    this.applyPaint();
  }

  private applyPaint(): void {
    const m = this.map;
    if (!m || !m.getLayer('hs-core')) return;
    const h = this.currentSettings.heat;
    const o = this.currentSettings.opacity;
    const S = this.currentSettings.size;
    const setPaint = (id: string, prop: string, val: unknown) => {
      if (m.getLayer(id)) m.setPaintProperty(id, prop as never, val as never);
    };

    setPaint('hs-core', 'circle-radius', this.radiusExpr(S));
    setPaint('hs-glow', 'circle-radius', this.radiusExpr(S * 2.6));
    setPaint('hs-core', 'circle-opacity', h ? 0.01 : o);
    setPaint('hs-core', 'circle-stroke-opacity', h ? 0 : o);
    setPaint('hs-glow', 'circle-opacity', 0.2 * o);
    setPaint('heat', 'heatmap-opacity', 0.8 * o);
    setPaint('heat', 'heatmap-radius', this.heatRadiusExpr(S));

    if (m.getLayer('warn')) {
      m.setLayoutProperty('warn', 'icon-size', ['interpolate', ['linear'], ['zoom'], 0, 0.45 * S, 5, 0.7 * S, 10, S]);
      m.setPaintProperty('warn', 'icon-opacity', o);
    }

    ['iris-borders', 'iris-admin1'].forEach((id) => {
      if (m.getLayer(id)) {
        m.setLayoutProperty(id, 'visibility', this.currentSettings.borders ? 'visible' : 'none');
      }
    });
  }

  private addSatEsri(): void {
    if (this.currentSettings.style !== 'sat' || !this.map) return;
    const m = this.map;
    if (!m.getSource('esri')) {
      const layers = m.getStyle().layers || [];
      const satIdx = layers.findIndex((l) => l.id === 'satellite');
      const before = satIdx >= 0 ? layers[satIdx + 1] : layers.find((l) => l.type === 'line' || l.type === 'symbol');
      m.addSource('esri', {
        type: 'raster',
        tileSize: 256,
        maxzoom: 17,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics'
      });
      m.addLayer({ id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-brightness-max': 0.75 } }, before?.id);
      try {
        m.setLayoutProperty('satellite', 'visibility', 'none');
      } catch {
        // ignore
      }
    }
    const hideRe = /road|poi|transit|airport|settlement-minor|settlement-subdivision|natural|waterway|building|ferry|bridge|tunnel/;
    m.getStyle().layers?.forEach((l) => {
      if (hideRe.test(l.id) && l.type !== 'raster') {
        m.setLayoutProperty(l.id, 'visibility', 'none');
      }
    });
  }

  private setFog(): void {
    if (!this.map) return;
    const s = this.currentSettings.style;
    if (s === 'terrain' || s === 'sat') {
      this.map.setFog({
        color: 'rgb(40,60,60)',
        'high-color': 'rgb(40,50,10)',
        'horizon-blend': 0.1,
        'space-color': 'rgb(5,0,8)',
        'star-intensity': 0.9
      });
      return;
    }
    this.map.setFog({
      color: 'rgb(20,28,46)',
      'high-color': 'rgb(14,165,196)',
      'horizon-blend': 0.08,
      'space-color': '#0B1220',
      'star-intensity': 0.4
    });
  }

  private styleBase(): void {
    if (!this.map) return;
    const m = this.map;
    const s = this.currentSettings.style;
    if (s === 'sat') {
      try {
        m.getStyle().layers?.forEach((l) => {
          if (l.type !== 'line' || !/^admin-[01]-boundary/.test(l.id)) return;
          m.setPaintProperty(l.id, 'line-opacity', /bg/.test(l.id) ? 0.15 : 0.4);
          m.setPaintProperty(l.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 1, 0.4, 8, 1]);
        });
      } catch {
        // ignore
      }
      return;
    }
    if (s !== 'dark') return;
    try {
      m.getStyle().layers?.forEach((l) => {
        if (l.type === 'background') m.setPaintProperty(l.id, 'background-color', '#1C2742');
        if (l.id === 'water') m.setPaintProperty(l.id, 'fill-color', '#070B16');
        if (l.type !== 'line' || !/^admin-[01]-boundary/.test(l.id)) return;
        const bg = /bg/.test(l.id);
        const a0 = l.id.startsWith('admin-0');
        const k = a0 ? 1 : 0.6;
        m.setPaintProperty(l.id, 'line-color', bg ? '#0B1220' : a0 ? '#B7CCF0' : '#6F86B3');
        m.setPaintProperty(l.id, 'line-opacity', bg ? 0.55 : 1);
        m.setPaintProperty(l.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 1, (bg ? 3 : 1.4) * k, 8, (bg ? 6 : 3.2) * k]);
      });
    } catch {
      // ignore
    }
  }

  private popAnchor(pt: { x: number; y: number }): mapboxgl.Anchor {
    const W = 300;
    const H = 270;
    const top = 125;
    const bot = window.innerHeight - 40;
    const v = pt.y - top > H + 14 ? 'bottom' : bot - pt.y > H + 14 ? 'top' : '';
    const h = pt.x < W / 2 + 70 ? 'left' : window.innerWidth - pt.x < W / 2 + 30 ? 'right' : '';
    return ([v, h].filter(Boolean).join('-') || (pt.x < window.innerWidth / 2 ? 'left' : 'right')) as mapboxgl.Anchor;
  }

  private showPopup(
    feature: mapboxgl.GeoJSONFeature,
    lngLat: mapboxgl.LngLat,
    pin: boolean
  ): void {
    if (!this.map) return;
    const p = (feature.properties || {}) as Record<string, unknown>;
    const rawCoords = (feature.geometry as GeoJSON.Point).coordinates;
    const c: [number, number] = [rawCoords[0], rawCoords[1]];
    while (Math.abs(lngLat.lng - c[0]) > 180) c[0] += lngLat.lng > c[0] ? 360 : -360;

    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    this.pinned = pin;

    const sev = (Number(p['sev']) || 1) as SeveridadNivel;
    const srcKey = (String(p['src'] || 'veg') as 'veg' | 'vol' | 'ind' | 'sea');
    const srcLabel = this.i18n.srcLabels()[srcKey] || this.i18n.srcLabels().veg;
    const sevName = this.i18n.sevNames()[sev] || '';
    const id = 'z' + Math.random().toString(36).slice(2, 8);
    const esc = (t: unknown) =>
      String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] || ch));

    const regionText = String(p['country'] || p['region'] || `${c[1].toFixed(2)}, ${c[0].toFixed(2)}`);
    const frpVal = Number(p['frp'] ?? 0);
    const scanVal = Number(p['scan'] ?? 0);
    const dateStr = String(p['date'] || '');
    const timeStr = String(p['time'] || '');
    const sensorStr = String(p['sensor'] || 'VIIRS');
    const confStr = String(p['confLabel'] || `${p['conf'] || 70}%`);

    const html = `<div class="pp" style="--c:${SEV_COLORS[sev]}"><div class="pp-h"><i></i>${esc(srcLabel)} · ${esc(sevName)}</div>
      <dl><dt>${this.i18n.l('Coordenadas', 'Coordinates')}</dt><dd>${c[1].toFixed(3)}, ${c[0].toFixed(3)}</dd>
      <dt>${this.i18n.l('País / Zona', 'Country / Area')}</dt><dd id="${id}">${esc(regionText)}</dd>
      <dt>FRP</dt><dd>${frpVal.toLocaleString(this.i18n.locale())} MW</dd>
      <dt>${this.i18n.l('Detección', 'Detection')}</dt><dd>${esc(sensorStr)} · ${esc(dateStr)} ${esc(timeStr)} UTC</dd>
      <dt>${this.i18n.l('Confianza', 'Confidence')}</dt><dd>${esc(confStr)}</dd>
      <dt>Scan</dt><dd>${scanVal.toFixed(2)} km</dd></dl>
      <p class="pp-n">MODIS + VIIRS · NASA FIRMS</p></div>`;

    this.popup = new mapboxgl.Popup({
      closeButton: pin,
      closeOnClick: false,
      offset: 12,
      className: 'iris-popup',
      maxWidth: '320px',
      anchor: this.popAnchor(this.map.project(c as LngLatLike))
    })
      .setLngLat(c)
      .setHTML(html)
      .addTo(this.map);

    if (pin) {
      this.popup.on('close', () => {
        this.pinned = false;
        this.interacting = false;
      });
    }

    void this.resolvePlaceName(c, id, String(p['country'] || ''));
  }

  private async resolvePlaceName(coords: [number, number], elId: string, countryFallback: string): Promise<void> {
    const k = `${coords[1].toFixed(2)},${coords[0].toFixed(2)}`;
    let name = this.geoCache[k];
    if (!name && this.token) {
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${coords[0]},${coords[1]}.json?types=locality,place,district,region&language=${this.i18n.lang()}&limit=1&access_token=${this.token}`
        );
        const json = await res.json();
        name = json.features?.[0]?.place_name;
        if (name) this.geoCache[k] = name;
      } catch {
        // ignore geocode failure
      }
    }
    const el = document.getElementById(elId);
    if (el && name) {
      el.textContent = countryFallback && !name.includes(countryFallback) ? `${name} (${countryFallback})` : name;
    }
  }

  private ringIn(ring: number[][], x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
    }
    return inside;
  }

  private polyIn(poly: number[][][], x: number, y: number): boolean {
    return this.ringIn(poly[0], x, y) && !poly.slice(1).some((hole) => this.ringIn(hole, x, y));
  }

  private geomIn(geom: { type: string; coordinates: unknown }, x: number, y: number): boolean {
    if (geom.type === 'Polygon') return this.polyIn(geom.coordinates as number[][][], x, y);
    if (geom.type === 'MultiPolygon') return (geom.coordinates as number[][][][]).some((p) => this.polyIn(p, x, y));
    return false;
  }

  private inCurrentArea(ll: mapboxgl.LngLat): boolean {
    if (this.drillState.level < 0) return false;
    const features = this.areaGeoJson.features as Array<{ geometry: { type: string; coordinates: unknown } }>;
    if (features.length) {
      return features.some((f) => this.geomIn(f.geometry, ll.lng, ll.lat));
    }
    const b = this.drillState.bbox;
    return !!b && ll.lng >= b[0] && ll.lng <= b[2] && ll.lat >= b[1] && ll.lat <= b[3];
  }

  private async revGeocode(ll: mapboxgl.LngLat, type: string): Promise<GeocodeFeature | null> {
    if (!this.token) return null;
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${ll.lng},${ll.lat}.json?types=${type}&language=${this.i18n.lang()}&limit=1&access_token=${this.token}`
    );
    const json = await res.json();
    return (json.features || [])[0] || null;
  }

  private async drill(ll: mapboxgl.LngLat): Promise<void> {
    if (this.drillState.busy || !this.map) return;
    this.drillState.busy = true;
    try {
      const start = this.inCurrentArea(ll) ? this.drillState.level + 1 : 0;
      if (start >= this.typesHierarchy.length) {
        this.emitToast({
          message: this.i18n.l('Ya estás en el nivel más detallado.', 'You are already at the most detailed level.')
        });
        return;
      }
      for (let i = start; i < this.typesHierarchy.length; i++) {
        const f = await this.revGeocode(ll, this.typesHierarchy[i]);
        if (f) {
          this.goToFeature(f);
          if (!this.drillState.hintShown) {
            this.drillState.hintShown = true;
            this.emitToast({
              message: this.i18n.l(
                'Vuelve a tocar dentro de la zona para ver el siguiente nivel.',
                'Click again inside the area to go one level deeper.'
              )
            });
          }
          return;
        }
      }
      this.emitToast({
        message: this.i18n.l('No hay más subdivisiones en este punto.', 'No further subdivisions at this point.')
      });
    } catch {
      this.emitToast({
        message: this.i18n.l('No se pudo consultar la zona. Revisa tu conexión.', 'Could not look up the area. Check your connection.'),
        isError: true
      });
    } finally {
      this.drillState.busy = false;
    }
  }

  private setArea(gj: { type: 'FeatureCollection'; features: unknown[] }, name: string): void {
    this.areaGeoJson = gj;
    if (this.map?.getSource('area')) {
      (this.map.getSource('area') as mapboxgl.GeoJSONSource).setData(
        gj as unknown as GeoJSON.FeatureCollection
      );
    }
    this.ngZone.run(() => this.areaName.set(name));
  }

  private async showArea(f: GeocodeFeature, fine: boolean): Promise<void> {
    const name = f.place_name;
    this.setArea({ type: 'FeatureCollection', features: [] }, name);
    if (this.areaMarker) {
      this.areaMarker.remove();
      this.areaMarker = null;
    }
    if (fine && this.map) {
      this.areaMarker = new mapboxgl.Marker({ color: '#FFB020' }).setLngLat(f.center).addTo(this.map);
      return;
    }
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0004&limit=3&accept-language=${this.i18n.lang()}&q=${encodeURIComponent(name)}`
      );
      const list = (await res.json()) as Array<{ geojson?: { type: string; coordinates: unknown } }>;
      const hit = list.find((x) => x.geojson && /Polygon/.test(x.geojson.type));
      if (hit && this.areaName() === name) {
        this.setArea(
          { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: hit.geojson }] },
          name
        );
      }
    } catch {
      // ignore Nominatim boundary errors
    }
  }
}

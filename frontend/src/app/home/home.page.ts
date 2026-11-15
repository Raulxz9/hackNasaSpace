import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { IonContent } from '@ionic/angular';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  FiltersPanelComponent,
  FooterBarComponent,
  HotspotToastComponent,
  MapGlobeComponent,
  MapSettingsPanelComponent,
  NavbarComponent,
  RiskPredictionPanelComponent,
  TimelineCalendarComponent
} from '../components';
import {
  AlertHotspot,
  Filtros,
  HotspotFeature,
  HotspotFeatureCollection,
  MapProjectionType,
  MapSettings,
  OrigenCalor,
  ResumenCalendario,
  SeveridadNivel
} from '../core/models';
import {
  CsvExportService,
  I18nService,
  IncendiosApiService,
  MapboxService,
  ToastNotice,
  dayNumFromUtcDate
} from '../core/services';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    NavbarComponent,
    MapGlobeComponent,
    FiltersPanelComponent,
    MapSettingsPanelComponent,
    TimelineCalendarComponent,
    RiskPredictionPanelComponent,
    HotspotToastComponent,
    FooterBarComponent
  ],
  templateUrl: './home.page.html'
})
export class HomePage implements OnDestroy {
  readonly i18n = inject(I18nService);
  private readonly api = inject(IncendiosApiService);
  readonly mapbox = inject(MapboxService);
  private readonly csvExport = inject(CsvExportService);

  @ViewChild('tokenDlg') tokenDlg?: ElementRef<HTMLDialogElement>;

  private readonly reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  private readonly nowUtc = new Date();
  private readonly todayDay = dayNumFromUtcDate(this.nowUtc.toISOString().slice(0, 10));

  readonly mapboxToken = signal<string>(this.resolveInitialToken());

  readonly settings = signal<MapSettings>({
    style: 'terrain',
    projection: 'globe',
    heat: true,
    borders: true,
    alerts: true,
    warn: false,
    pred: false,
    glass: this.resolveInitialGlass(),
    size: 1,
    opacity: 0.95,
    spin: !this.reduceMotion
  });

  readonly alertsTopPx = signal<number | null>(null);
  readonly musicMuted = signal<boolean>(this.resolveInitialMuted());
  private audioEl: HTMLAudioElement | null = null;
  private readonly gestureEvents: ReadonlyArray<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
  private readonly onMusicGesture = (): void => {
    this.tryPlayMusic();
  };

  readonly filters = signal<Filtros>({
    severidades: new Set<SeveridadNivel>([1, 2, 3, 4, 5]),
    origenes: new Set<OrigenCalor>(['veg', 'vol', 'ind', 'sea']),
    startDay: this.todayDay - 6,
    endDay: this.todayDay
  });

  readonly live = signal<boolean>(true);
  readonly timelineOpen = signal<boolean>(false);
  readonly predictionOpen = signal<boolean>(false);
  readonly openLeftPanel = signal<'filters' | 'settings' | null>(null);

  readonly timelineYear = signal<number>(Math.max(2000, this.nowUtc.getUTCFullYear()));
  readonly timelineMonth = signal<number>(this.nowUtc.getUTCMonth() + 1);
  readonly timelineDay = signal<number>(0);

  readonly liveCollection = signal<HotspotFeatureCollection>({ type: 'FeatureCollection', features: [] });
  readonly timelineCollection = signal<HotspotFeatureCollection>({ type: 'FeatureCollection', features: [] });
  readonly dayCollection = signal<HotspotFeatureCollection | null>(null);
  readonly resumen = signal<ResumenCalendario | null>(null);
  readonly loadingResumen = signal<boolean>(false);
  readonly loadingMonthHotspots = signal<boolean>(false);
  readonly loadingDayHotspots = signal<boolean>(false);
  readonly playbackActive = signal<boolean>(false);
  readonly timelineMonthTruncated = signal<boolean>(false);
  readonly usingDefaultFilters = computed(
    () => this.filters().severidades.size === 5 && this.filters().origenes.size === 4
  );

  readonly alerts = signal<AlertHotspot[]>([]);
  readonly toast = signal<ToastNotice | null>(null);

  private wasLiveBeforeTimeline = true;
  private livePollTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private alertAutoClearTimer: ReturnType<typeof setTimeout> | null = null;
  private liveSub: Subscription | null = null;
  private resumenSub: Subscription | null = null;
  private resumenBgSub: Subscription | null = null;
  private monthSub: Subscription | null = null;
  private daySub: Subscription | null = null;
  private loadedMonthKey = '';
  private mapContainerEl: HTMLElement | null = null;

  readonly activeCollection = computed<HotspotFeatureCollection>(() => {
    if (!this.timelineOpen()) return this.liveCollection();
    if (!this.playbackActive() && this.timelineDay() > 0 && this.dayCollection() !== null) {
      return this.dayCollection()!;
    }
    return this.timelineCollection();
  });

  readonly visibleFeatures = computed<HotspotFeature[]>(() => {
    const f = this.filters();
    return this.activeCollection().features.filter((feat) => {
      const p = feat.properties;
      return (
        p.day >= f.startDay &&
        p.day <= f.endDay &&
        f.severidades.has(p.sev) &&
        f.origenes.has(p.src)
      );
    });
  });

  readonly warnMinDay = computed<number>(() =>
    this.api.liveWindowMode() === '48h' ? this.todayDay - 1 : this.todayDay
  );

  readonly warnCount = computed<number>(() => {
    const f = this.filters();
    const minD = this.warnMinDay();
    return this.liveCollection().features.filter((feat) => {
      const p = feat.properties;
      return p.day >= minD && f.severidades.has(p.sev) && f.origenes.has(p.src);
    }).length;
  });

  constructor() {
    this.mapbox.registerCallbacks(
      (notice) => this.showToast(notice),
      (spinning) => {
        if (this.settings().spin !== spinning) {
          this.settings.update((s) => ({ ...s, spin: spinning }));
        }
      }
    );

    effect(() => {
      if (this.mapbox.tokenError()) {
        this.tokenDlg?.nativeElement.showModal();
      }
    });

    this.initAmbientMusic();
  }

  ngOnDestroy(): void {
    this.stopLivePolling();
    this.liveSub?.unsubscribe();
    this.resumenSub?.unsubscribe();
    this.resumenBgSub?.unsubscribe();
    this.monthSub?.unsubscribe();
    this.daySub?.unsubscribe();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.alertAutoClearTimer) clearTimeout(this.alertAutoClearTimer);
    this.cleanupAmbientMusic();
  }

  private resolveInitialGlass(): boolean {
    try {
      const enabled = localStorage.getItem('iris_glass') !== '0';
      document.documentElement.classList.toggle('flat', !enabled);
      return enabled;
    } catch {
      return true;
    }
  }

  private resolveInitialMuted(): boolean {
    try {
      return localStorage.getItem('iris_muted') === '1';
    } catch {
      return false;
    }
  }

  private initAmbientMusic(): void {
    if (typeof Audio === 'undefined') return;
    const audio = new Audio('assets/cancioncitaUwU.mp3');
    audio.loop = true;
    audio.volume = 0.15;
    audio.preload = 'auto';
    this.audioEl = audio;
    this.gestureEvents.forEach((ev) => window.addEventListener(ev, this.onMusicGesture, true));
    this.tryPlayMusic();
  }

  private tryPlayMusic(): void {
    if (!this.audioEl || this.musicMuted()) return;
    this.audioEl
      .play()
      .then(() => {
        this.gestureEvents.forEach((ev) => window.removeEventListener(ev, this.onMusicGesture, true));
      })
      .catch(() => {
        // esperar primer gesto de usuario según políticas del navegador
      });
  }

  private cleanupAmbientMusic(): void {
    this.gestureEvents.forEach((ev) => window.removeEventListener(ev, this.onMusicGesture, true));
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl = null;
    }
  }

  onToggleMusic(): void {
    const muted = !this.musicMuted();
    this.musicMuted.set(muted);
    try {
      localStorage.setItem('iris_muted', muted ? '1' : '0');
    } catch {
      // ignore storage errors
    }
    if (!this.audioEl) return;
    if (muted) {
      this.audioEl.pause();
    } else {
      this.audioEl.play().catch(() => {});
    }
  }

  private resolveInitialToken(): string {
    try {
      const saved = localStorage.getItem('iris_mapbox_token')?.trim();
      if (saved) return saved;
    } catch {
      // ignore storage access issues
    }
    return environment.mapboxToken;
  }

  onMapContainerReady(container: HTMLElement): void {
    this.mapContainerEl = container;
    const token = this.mapboxToken();
    if (token) {
      this.startMapWithToken(token);
    } else {
      this.tokenDlg?.nativeElement.showModal();
    }
    if (this.live()) {
      this.startLivePolling();
    }
  }

  private startMapWithToken(token: string): void {
    if (!this.mapContainerEl) return;
    this.mapbox.initMap(
      this.mapContainerEl,
      token,
      this.settings(),
      this.filters(),
      this.warnMinDay()
    );
    this.mapbox.locateMe();
    const active = this.activeCollection();
    if (active.features.length) {
      this.mapbox.setHotspotsData(active, this.warnMinDay());
    }
  }

  onSaveTokenFromDialog(raw: string): void {
    const token = raw.trim();
    if (!token) return;
    try {
      localStorage.setItem('iris_mapbox_token', token);
    } catch {
      // ignore storage errors
    }
    this.mapboxToken.set(token);
    this.tokenDlg?.nativeElement.close();
    this.startMapWithToken(token);
  }

  onToggleLive(): void {
    if (this.timelineOpen()) {
      this.wasLiveBeforeTimeline = false;
      this.onExitTimeline();
    }
    const next = !this.live();
    this.live.set(next);
    if (next) {
      this.startLivePolling();
      this.showToast({
        message: this.i18n.l(
          'Live encendido: sincronizando datos reales NASA FIRMS.',
          'Live on: syncing real NASA FIRMS data.'
        )
      });
    } else {
      this.stopLivePolling();
      this.showToast({
        message: this.i18n.l('Live en pausa.', 'Live paused.')
      });
    }
  }

  private startLivePolling(): void {
    this.stopLivePolling();
    const f = this.filters();
    if (f.endDay !== this.todayDay) {
      const span = f.endDay - f.startDay;
      this.updateDayRange(this.todayDay - span, this.todayDay);
    }
    this.fetchLiveNow();
    this.livePollTimer = setInterval(() => {
      if (!this.timelineOpen() && this.live()) {
        this.fetchLiveNow();
      }
    }, environment.liveRefreshMs);
  }

  private stopLivePolling(): void {
    if (this.livePollTimer) {
      clearInterval(this.livePollTimer);
      this.livePollTimer = null;
    }
    this.liveSub?.unsubscribe();
  }

  private fetchLiveNow(): void {
    this.liveSub?.unsubscribe();
    this.liveSub = this.api.fetchLiveHotspots().subscribe({
      next: (fc) => {
        this.liveCollection.set(fc);
        if (!this.timelineOpen()) {
          this.mapbox.setHotspotsData(fc, this.warnMinDay());
        }
        if (this.settings().alerts && fc.features.length > 0) {
          this.pushAlerts(this.api.extractTopAlerts(fc, 3));
        }
      },
      error: (err) => {
        const backendMsg = err?.error?.detalle || err?.error?.error;
        const shortDetail =
          typeof backendMsg === 'string' && backendMsg.includes('Unable to detect a Project Id')
            ? this.i18n.l(
                'Faltan credenciales de Google Cloud en backend/.env.',
                'Missing Google Cloud credentials in backend/.env.'
              )
            : typeof backendMsg === 'string' && backendMsg.length > 0 && backendMsg.length <= 110
              ? backendMsg
              : this.i18n.l(
                  'No se pudieron obtener focos en vivo. Verifica el servidor backend.',
                  'Could not fetch live hotspots. Check backend server.'
                );
        this.showToast({
          message: shortDetail,
          isError: true
        });
      }
    });
  }

  private pushAlerts(items: AlertHotspot[]): void {
    this.alerts.set(items);
    if (this.alertAutoClearTimer) clearTimeout(this.alertAutoClearTimer);
    this.alertAutoClearTimer = setTimeout(() => {
      this.alerts.set([]);
    }, 9000);
  }

  onDismissAlert(id: string): void {
    this.alerts.update((list) => list.filter((a) => a.id !== id));
  }

  onToggleWarn(): void {
    const nextWarn = !this.settings().warn;
    this.onSettingsChange({ warn: nextWarn });
    this.showToast({
      message: nextWarn
        ? this.i18n.l(
            '⚠️ Mostrando focos recientes en el mapa. Toca uno para acercar.',
            '⚠️ Showing recent hotspots on the map. Tap one to zoom in.'
          )
        : this.i18n.l('Focos nuevos ocultos.', 'New hotspots hidden.')
    });
  }

  onToggleTimeline(): void {
    if (this.timelineOpen()) {
      this.onExitTimeline();
      return;
    }
    this.predictionOpen.set(false);
    this.wasLiveBeforeTimeline = this.live();
    if (this.live()) {
      this.live.set(false);
      this.stopLivePolling();
    }
    this.timelineOpen.set(true);
    this.dayCollection.set(null);
    this.loadingDayHotspots.set(false);
    this.loadTimelineData(this.timelineYear(), this.timelineMonth(), this.timelineDay());
    if (this.timelineDay() > 0) {
      this.onSelectTimelineDay(this.timelineDay());
    }
  }

  onExitTimeline(): void {
    if (!this.timelineOpen()) return;
    this.mapbox.clearPeakMarker();
    this.resumenSub?.unsubscribe();
    this.resumenBgSub?.unsubscribe();
    this.monthSub?.unsubscribe();
    this.daySub?.unsubscribe();
    this.dayCollection.set(null);
    this.loadingDayHotspots.set(false);
    this.playbackActive.set(false);
    this.timelineOpen.set(false);
    this.updateDayRange(this.todayDay - 6, this.todayDay);
    this.mapbox.setHotspotsData(this.liveCollection(), this.warnMinDay());
    if (this.wasLiveBeforeTimeline) {
      this.live.set(true);
      this.startLivePolling();
    }
  }

  onSelectTimelineYear(year: number): void {
    this.mapbox.clearPeakMarker();
    const nowY = Math.max(2026, this.nowUtc.getUTCFullYear());
    const nowM = this.nowUtc.getUTCMonth() + 1;
    const nextMonth = year === nowY ? Math.min(this.timelineMonth(), nowM) : this.timelineMonth();
    this.timelineYear.set(year);
    this.timelineMonth.set(nextMonth);
    this.timelineDay.set(0);
    this.daySub?.unsubscribe();
    this.dayCollection.set(null);
    this.loadingDayHotspots.set(false);
    this.loadTimelineData(year, nextMonth, 0);
  }

  onSelectTimelineMonth(month: number): void {
    this.mapbox.clearPeakMarker();
    this.timelineMonth.set(month);
    this.timelineDay.set(0);
    this.daySub?.unsubscribe();
    this.dayCollection.set(null);
    this.loadingDayHotspots.set(false);
    this.loadTimelineData(this.timelineYear(), month, 0);
  }

  onSelectTimelineDay(day: number): void {
    this.mapbox.clearPeakMarker();
    const year = this.timelineYear();
    const month = this.timelineMonth();
    this.timelineDay.set(day);
    this.daySub?.unsubscribe();
    this.applyTimelineDayRange(year, month, day);

    if (day === 0) {
      this.dayCollection.set(null);
      this.loadingDayHotspots.set(false);
      if (this.timelineOpen()) {
        this.mapbox.setHotspotsData(this.timelineCollection(), this.warnMinDay());
      }
      return;
    }

    // Si el mes completo ya está cargado sin truncamiento, filtra en GPU al instante sin nueva petición HTTP
    const monthKey = `${year}-${month}`;
    if (
      this.loadedMonthKey === monthKey &&
      !this.loadingMonthHotspots() &&
      !this.timelineMonthTruncated()
    ) {
      this.dayCollection.set(null);
      this.loadingDayHotspots.set(false);
      if (this.timelineOpen()) {
        this.mapbox.setHotspotsData(this.timelineCollection(), this.warnMinDay());
      }
      return;
    }

    const fecha = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    this.dayCollection.set(null);
    this.loadingDayHotspots.set(true);

    this.daySub = this.api.fetchDayHotspots(fecha).subscribe({
      next: (fc) => {
        if (!this.timelineOpen() || this.timelineYear() !== year || this.timelineMonth() !== month || this.timelineDay() !== day) {
          return;
        }
        this.dayCollection.set(fc);
        this.loadingDayHotspots.set(false);
        this.mapbox.setHotspotsData(fc, this.warnMinDay());
      },
      error: () => {
        this.loadingDayHotspots.set(false);
        if (this.timelineOpen()) {
          this.mapbox.setHotspotsData(this.timelineCollection(), this.warnMinDay());
          this.showToast({
            message: this.i18n.l(
              'No se pudieron cargar los focos para esa fecha.',
              'Could not load hotspots for that date.'
            ),
            isError: true
          });
        }
      }
    });
  }

  onTimelinePlaybackChange(playing: boolean): void {
    this.playbackActive.set(playing);
    if (playing) {
      this.daySub?.unsubscribe();
      this.loadingDayHotspots.set(false);
      this.dayCollection.set(null);
      if (this.timelineOpen()) {
        this.mapbox.setHotspotsData(this.timelineCollection(), this.warnMinDay());
      }
    }
  }

  onPlayTimelineDay(day: number): void {
    this.timelineDay.set(day);
    this.applyTimelineDayRange(this.timelineYear(), this.timelineMonth(), day);
  }

  private applyTimelineDayRange(year: number, month: number, day: number): void {
    const nDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const first = Math.floor(Date.UTC(year, month - 1, 1) / 864e5);
    const startDay = day ? first + day - 1 : first;
    const endDay = day ? startDay : first + nDays - 1;
    this.updateDayRange(startDay, endDay);
  }

  private loadTimelineData(year: number, month: number, day: number): void {
    this.applyTimelineDayRange(year, month, day);

    this.resumenSub?.unsubscribe();
    this.resumenBgSub?.unsubscribe();
    this.monthSub?.unsubscribe();

    const monthKey = `${year}-${month}`;
    this.loadedMonthKey = '';
    this.timelineMonthTruncated.set(false);

    // Conserva las barras anuales ya conocidas al cambiar de mes dentro del mismo año
    const prevResumen = this.resumen();
    const yearBars =
      prevResumen && prevResumen.anio === year && prevResumen.resumenMensual?.length === 12
        ? prevResumen.resumenMensual
        : this.api.getCachedYearSummary(year);
    if (yearBars?.length === 12) {
      this.resumen.set({
        anio: year,
        mes: month,
        pais: 'Global',
        parcial: true,
        resumenMensual: yearBars
      });
    } else {
      this.resumen.set(null);
    }

    this.loadingResumen.set(true);
    this.loadingMonthHotspots.set(true);

    this.resumenSub = this.api.fetchResumen(year, month, undefined, 'rapido').subscribe({
      next: (res) => {
        if (this.timelineYear() !== year || this.timelineMonth() !== month) return;
        this.resumen.set(res);
        this.loadingResumen.set(false);

        if (res.parcial) {
          this.resumenBgSub?.unsubscribe();
          this.resumenBgSub = this.api.fetchResumen(year, month, undefined, 'completo').subscribe({
            next: (fullRes) => {
              if (this.timelineOpen() && this.timelineYear() === year && this.timelineMonth() === month) {
                this.resumen.set(fullRes);
              }
            },
            error: () => {
              // Mantiene el resumen rápido ya visible si falla la carga completa en segundo plano
            }
          });
        }
      },
      error: () => {
        this.loadingResumen.set(false);
      }
    });

    this.monthSub = this.api.fetchMonthWithMeta(year, month).subscribe({
      next: (res) => {
        if (this.timelineYear() !== year || this.timelineMonth() !== month) return;
        this.timelineCollection.set(res.fc);
        this.timelineMonthTruncated.set(res.truncado);
        this.loadedMonthKey = monthKey;
        this.loadingMonthHotspots.set(false);
        if (
          this.timelineOpen() &&
          (this.playbackActive() ||
            this.timelineDay() === 0 ||
            !res.truncado ||
            (!this.dayCollection() && !this.loadingDayHotspots()))
        ) {
          this.mapbox.setHotspotsData(res.fc, this.warnMinDay());
        }
      },
      error: () => {
        if (this.timelineYear() !== year || this.timelineMonth() !== month) return;
        this.timelineCollection.set({ type: 'FeatureCollection', features: [] });
        this.timelineMonthTruncated.set(false);
        this.loadedMonthKey = monthKey;
        this.loadingMonthHotspots.set(false);
        if (this.timelineOpen() && !this.dayCollection()) {
          this.mapbox.setHotspotsData({ type: 'FeatureCollection', features: [] }, this.warnMinDay());
        }
        this.showToast({
          message: this.i18n.l(
            'No hay registros disponibles en GCS para esa fecha.',
            'No records available in GCS for that date.'
          ),
          isError: true
        });
      }
    });
  }

  onGoTimelinePeak(): void {
    const feats = this.visibleFeatures();
    if (!feats.length) {
      this.showToast({
        message: this.i18n.l(
          'No hay focos visibles en este periodo. Revisa los filtros.',
          'No visible hotspots in this period. Check the filters.'
        )
      });
      return;
    }
    const peak = feats.reduce((best, cur) =>
      cur.properties.sev > best.properties.sev ||
      (cur.properties.sev === best.properties.sev && cur.properties.frp > best.properties.frp)
        ? cur
        : best
    );
    this.mapbox.focusPeakHotspot(peak);
  }

  onTogglePrediction(): void {
    const next = !this.predictionOpen();
    if (next && this.timelineOpen()) {
      this.onExitTimeline();
    }
    this.predictionOpen.set(next);
  }

  onPredictionLayerChange(visible: boolean): void {
    this.onSettingsChange({ pred: visible });
  }

  onToggleLeftPanel(panel: 'filters' | 'settings'): void {
    this.openLeftPanel.update((cur) => (cur === panel ? null : panel));
  }

  onToggleSeverity(ev: { sev: SeveridadNivel; checked: boolean }): void {
    const cur = this.filters();
    const nextSevs = new Set(cur.severidades);
    if (ev.checked) {
      nextSevs.add(ev.sev);
    } else if (nextSevs.size > 1) {
      nextSevs.delete(ev.sev);
    } else {
      this.showToast({
        message: this.i18n.l('Deja al menos una opción activa.', 'Keep at least one option active.')
      });
      return;
    }
    const updated: Filtros = { ...cur, severidades: nextSevs };
    this.filters.set(updated);
    this.mapbox.applyFilters(updated, this.warnMinDay());
  }

  onToggleSource(ev: { src: OrigenCalor; checked: boolean }): void {
    const cur = this.filters();
    const nextSrcs = new Set(cur.origenes);
    if (ev.checked) {
      nextSrcs.add(ev.src);
    } else if (nextSrcs.size > 1) {
      nextSrcs.delete(ev.src);
    } else {
      this.showToast({
        message: this.i18n.l('Deja al menos una opción activa.', 'Keep at least one option active.')
      });
      return;
    }
    const updated: Filtros = { ...cur, origenes: nextSrcs };
    this.filters.set(updated);
    this.mapbox.applyFilters(updated, this.warnMinDay());
  }

  onSettingsChange(patch: Partial<MapSettings>): void {
    this.settings.update((cur) => {
      const next = { ...cur, ...patch };
      if (patch.glass !== undefined) {
        document.documentElement.classList.toggle('flat', !next.glass);
        try {
          localStorage.setItem('iris_glass', next.glass ? '1' : '0');
        } catch {
          // ignore storage errors
        }
      }
      if (!next.alerts) {
        this.alerts.set([]);
      }
      this.mapbox.updateSettings(next);
      return next;
    });
  }

  onProjectionChange(projection: MapProjectionType): void {
    this.settings.update((cur) => ({ ...cur, projection }));
  }

  onResetView(): void {
    if (this.timelineOpen()) {
      this.onExitTimeline();
    }
    this.mapbox.resetView();
    this.updateDayRange(this.todayDay - 6, this.todayDay);
  }

  onExportCsv(): void {
    const feats = this.visibleFeatures();
    if (!feats.length) {
      this.showToast({
        message: this.i18n.l(
          'No hay focos visibles para exportar con los filtros actuales.',
          'No visible hotspots to export with the current filters.'
        )
      });
      return;
    }
    const slug = this.timelineOpen()
      ? `iris-${this.timelineYear()}-${String(this.timelineMonth()).padStart(2, '0')}${
          this.timelineDay() ? '-' + String(this.timelineDay()).padStart(2, '0') : ''
        }`
      : `iris-live-${this.nowUtc.toISOString().slice(0, 10)}`;
    this.csvExport.exportFilteredFeaturesCsv(feats, slug);
    this.showToast({
      message: this.i18n.l(
        `CSV descargado (${feats.length.toLocaleString(this.i18n.locale())} focos reales).`,
        `CSV downloaded (${feats.length.toLocaleString(this.i18n.locale())} real hotspots).`
      )
    });
  }

  showToast(notice: ToastNotice): void {
    this.toast.set(notice);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.set(null);
    }, notice.flyTo ? 8000 : 4200);
  }

  private updateDayRange(startDay: number, endDay: number): void {
    const cur = this.filters();
    const updated: Filtros = { ...cur, startDay, endDay };
    this.filters.set(updated);
    this.mapbox.applyFilters(updated, this.warnMinDay());
  }
}

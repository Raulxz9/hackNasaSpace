import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { Subscription, catchError, from, mergeMap, of, toArray } from 'rxjs';
import {
  HistorialAnualResponse,
  HotspotFeature,
  IncendiosQueryParams,
  ResumenCalendario,
  ResumenDiaItem,
  ResumenMesItem,
  SeveridadNivel
} from '../../core/models';
import {
  CsvExportService,
  I18nService,
  IncendiosApiService,
  MapboxService,
  THERMAL_LEGEND_STOPS,
  computeThermalLogNorm,
  computeThermalRampColor,
  dayNumFromUtcDate
} from '../../core/services';

interface ListRow {
  values: Record<string, string | number>;
  sev: SeveridadNivel;
}

@Component({
  selector: 'app-timeline-calendar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-calendar.component.html'
})
export class TimelineCalendarComponent implements OnDestroy {
  readonly i18n = inject(I18nService);
  protected readonly Math = Math;
  private readonly csvExport = inject(CsvExportService);
  private readonly api = inject(IncendiosApiService);
  private readonly mapbox = inject(MapboxService);

  readonly open = input.required<boolean>();
  readonly selectedYear = input.required<number>();
  readonly selectedMonth = input.required<number>(); // 1..12
  readonly selectedDay = input.required<number>(); // 0 = all month, 1..31
  readonly resumen = input<ResumenCalendario | null>(null);
  readonly loadingResumen = input<boolean>(false);
  readonly loadingHotspots = input<boolean>(false);
  readonly monthFeatures = input<HotspotFeature[]>([]);
  readonly dayFeatures = input<HotspotFeature[]>([]);
  readonly visibleFeatures = input<HotspotFeature[]>([]);
  readonly monthTruncated = input<boolean>(false);
  readonly usingDefaultFilters = input<boolean>(true);
  readonly historialAnual = input<HistorialAnualResponse | null>(null);
  readonly areaLabel = input<string>('Global');

  readonly selectYear = output<number>();
  readonly selectMonth = output<number>();
  readonly selectDay = output<number>();
  readonly playStep = output<number>();
  readonly playingChange = output<boolean>();
  readonly goPeak = output<void>();
  readonly exportCsv = output<void>();
  readonly exitTimeline = output<void>();
  readonly openHistory = output<void>();
  readonly notifyToast = output<{ message: string; isError?: boolean }>();

  @ViewChild('yearList') yearList?: ElementRef<HTMLElement>;
  @ViewChild('monthList') monthList?: ElementRef<HTMLElement>;
  @ViewChild('dayList') dayList?: ElementRef<HTMLElement>;
  @ViewChild('askDlg') askDlg?: ElementRef<HTMLDialogElement>;
  @ViewChild('listDlg') listDlg?: ElementRef<HTMLDialogElement>;
  @ViewChild('dlDlg') dlDlg?: ElementRef<HTMLDialogElement>;

  readonly nowUtc = new Date();
  readonly currentYear = Math.max(2026, this.nowUtc.getUTCFullYear());
  readonly currentMonth = this.nowUtc.getUTCMonth() + 1;
  readonly currentDay = this.nowUtc.getUTCDate();
  readonly todayIso = this.nowUtc.toISOString().slice(0, 10);
  readonly todayDay = dayNumFromUtcDate(this.todayIso);

  readonly years: number[] = Array.from(
    { length: this.currentYear - 1999 },
    (_, i) => 2000 + i
  );

  readonly dlPresets = [
    { days: 7, labelKey: 'Últimos 7 días' },
    { days: 30, labelKey: 'Últimos 30 días' },
    { days: 90, labelKey: 'Últimos 90 días' },
    { days: 365, labelKey: 'Último año' }
  ] as const;

  readonly playing = signal(false);
  readonly listOpen = signal(false);
  readonly listDayFilter = signal<number>(0);
  readonly yearPopOpen = signal(false);
  readonly moreMenuOpen = signal(false);
  readonly severities: SeveridadNivel[] = [1, 2, 3, 4, 5];

  readonly dlBox = signal<[number, number, number, number] | null>(null);
  readonly dlRegionName = signal<string>('');
  readonly dlFrom = signal<string>('');
  readonly dlTo = signal<string>('');
  readonly dlMsg = signal<string>('');
  readonly dlBusy = signal<boolean>(false);

  private playTimer: ReturnType<typeof setInterval> | null = null;
  private dlSub: Subscription | null = null;

  readonly sevColors: Record<SeveridadNivel, string> = {
    1: '#FACC15',
    2: '#FB923C',
    3: '#EF4444',
    4: '#B91C1C',
    5: '#7F1D1D'
  };

  readonly daysInSelectedMonth = computed(() =>
    new Date(Date.UTC(this.selectedYear(), this.selectedMonth(), 0)).getUTCDate()
  );

  readonly legendStops = THERMAL_LEGEND_STOPS;

  readonly monthlyItems = computed<
    Array<ResumenMesItem & { intensityNorm: number; rampHex: string; isPeakMonth: boolean; isSeasonalPeak: boolean; seasonalAvg: number }>
  >(() => {
    const items = this.resumen()?.resumenMensual || [];
    const byMonth = new Map<number, ResumenMesItem>();
    items.forEach((it) => byMonth.set(it.mes, it));
    const maxVal = Math.max(1, ...items.map((it) => it.totalFocos));
    const hist = this.historialAnual();
    const seasonalTopSet = new Set((hist?.topMesesEstacionales || []).slice(0, 3).map((m) => m.mes));
    let yearPeakMonth = 0;
    let yearPeakCount = 0;
    items.forEach((it) => {
      if (it.totalFocos > yearPeakCount) {
        yearPeakCount = it.totalFocos;
        yearPeakMonth = it.mes;
      }
    });

    return Array.from({ length: 12 }, (_, idx) => {
      const m = idx + 1;
      const item = byMonth.get(m) || {
        mes: m,
        totalFocos: 0,
        frpMax: 0,
        intensidadMaxima: 'Sin datos',
        nivelMaximo: 0
      };
      const norm = computeThermalLogNorm(item.totalFocos, maxVal);
      const seasonalAvg = hist?.porMes?.[idx]?.promedioAnual ?? 0;
      return {
        ...item,
        intensityNorm: norm,
        rampHex: computeThermalRampColor(norm),
        isPeakMonth: m === yearPeakMonth && item.totalFocos > 0,
        isSeasonalPeak: seasonalTopSet.has(m),
        seasonalAvg: Math.round(seasonalAvg)
      };
    });
  });

  readonly dailyItems = computed<Array<ResumenDiaItem & { intensityNorm: number; rampHex: string }>>(() => {
    const nDays = this.daysInSelectedMonth();
    const y = this.selectedYear();
    const mStr = String(this.selectedMonth()).padStart(2, '0');
    const items = this.resumen()?.resumenDiario || [];
    const byDay = new Map<number, ResumenDiaItem>();
    items.forEach((d) => byDay.set(d.dia, d));

    const featCounts = new Map<number, number>();
    if (items.length === 0) {
      for (const f of this.monthFeatures()) {
        const d = parseInt(f.properties.date.slice(8, 10), 10);
        if (d >= 1 && d <= nDays) featCounts.set(d, (featCounts.get(d) || 0) + 1);
      }
    }

    const counts = Array.from({ length: nDays }, (_, i) => {
      const d = i + 1;
      return byDay.get(d)?.totalFocos ?? featCounts.get(d) ?? 0;
    });
    const maxVal = Math.max(1, ...counts);

    return Array.from({ length: nDays }, (_, i) => {
      const d = i + 1;
      const existing = byDay.get(d);
      const total = existing?.totalFocos ?? featCounts.get(d) ?? 0;
      const norm = computeThermalLogNorm(total, maxVal);
      return {
        dia: d,
        fecha: existing?.fecha ?? `${y}-${mStr}-${String(d).padStart(2, '0')}`,
        totalFocos: total,
        frpMax: existing?.frpMax ?? 0,
        intensidadMaxima: existing?.intensidadMaxima ?? 'Sin datos',
        nivelMaximo: existing?.nivelMaximo ?? 0,
        intensityNorm: norm,
        rampHex: computeThermalRampColor(norm)
      };
    });
  });

  readonly sevCounts = computed<Record<SeveridadNivel, number>>(() => {
    const counts: Record<SeveridadNivel, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const dist = this.resumen()?.distribucionIntensidad;
    if (
      this.selectedDay() === 0 &&
      this.monthTruncated() &&
      this.usingDefaultFilters() &&
      !this.playing() &&
      dist
    ) {
      ([1, 2, 3, 4, 5] as SeveridadNivel[]).forEach((s) => {
        counts[s] = Number(dist[s] || 0);
      });
      return counts;
    }
    const feats = this.visibleFeatures();
    if (feats.length > 0) {
      for (const f of feats) {
        counts[f.properties.sev]++;
      }
      return counts;
    }
    if (dist && this.selectedDay() === 0 && this.usingDefaultFilters()) {
      ([1, 2, 3, 4, 5] as SeveridadNivel[]).forEach((s) => {
        counts[s] = Number(dist[s] || 0);
      });
    }
    return counts;
  });

  readonly totalDisplayCount = computed(() => {
    if (
      this.selectedDay() === 0 &&
      this.monthTruncated() &&
      this.usingDefaultFilters() &&
      !this.playing()
    ) {
      const summaryTotal = this.resumen()?.resumenDiario?.reduce((acc, d) => acc + d.totalFocos, 0) ?? 0;
      if (summaryTotal > 0) return summaryTotal;
    }
    const visible = this.visibleFeatures().length;
    if (visible > 0) return visible;
    if (!this.usingDefaultFilters() && !this.loadingHotspots()) return 0;
    if (this.selectedDay() === 0) {
      return this.dailyItems().reduce((acc, d) => acc + d.totalFocos, 0);
    }
    return this.dailyItems()[this.selectedDay() - 1]?.totalFocos ?? 0;
  });

  readonly peakLevel = computed<SeveridadNivel>(() => {
    const counts = this.sevCounts();
    if (counts[5]) return 5;
    if (counts[4]) return 4;
    if (counts[3]) return 3;
    if (counts[2]) return 2;
    if (counts[1]) return 1;
    const fromResumen = this.resumen()?.nivelMaximoMes || 1;
    return Math.max(1, Math.min(5, fromResumen)) as SeveridadNivel;
  });

  readonly busiestDayInfo = computed(() => {
    const fromResumen = this.resumen()?.diaPico;
    if (fromResumen && fromResumen.totalFocos > 0) return fromResumen;
    let best = { dia: 1, totalFocos: 0 };
    for (const d of this.dailyItems()) {
      if (d.totalFocos > best.totalFocos) best = { dia: d.dia, totalFocos: d.totalFocos };
    }
    return best;
  });

  readonly medianComparison = computed<{ median: number; deltaPct: number } | null>(() => {
    const med = this.resumen()?.medianaHistoricaMes;
    if (med === undefined || med === null || med <= 0 || this.selectedDay() !== 0) return null;
    const monthTotal = this.dailyItems().reduce((acc, d) => acc + d.totalFocos, 0) || this.totalDisplayCount();
    const deltaPct = Math.round(((monthTotal - med) / med) * 100);
    return { median: med, deltaPct };
  });

  readonly periodTitle = computed(() => {
    const monthName = this.i18n.meses()[this.selectedMonth() - 1];
    const d = this.selectedDay();
    if (!d) return `${monthName} ${this.selectedYear()}`;
    return this.i18n.lang() === 'en'
      ? `${monthName} ${d}, ${this.selectedYear()}`
      : `${d} de ${monthName} ${this.selectedYear()}`;
  });

  readonly sortedListFeatures = computed<HotspotFeature[]>(() => {
    if (!this.listOpen()) return [];
    const dFilter = this.listDayFilter();

    const monthFiltered = this.monthFeatures().filter((f) => {
      if (!dFilter) return true;
      const d = parseInt(f.properties.date.slice(8, 10), 10);
      return d === dFilter;
    });

    const dayOnlyFiltered = this.dayFeatures().filter((f) => {
      if (!dFilter) return true;
      const d = parseInt(f.properties.date.slice(8, 10), 10);
      return d === dFilter;
    });

    const baseList =
      dFilter > 0 && dFilter === this.selectedDay() && dayOnlyFiltered.length > monthFiltered.length
        ? dayOnlyFiltered
        : monthFiltered;

    return baseList
      .slice()
      .sort((a, b) => (a.properties.date + a.properties.time < b.properties.date + b.properties.time ? -1 : 1));
  });

  readonly listTotalCount = computed(() => this.sortedListFeatures().length);

  readonly yearPickerItems = computed<
    Array<{ anio: number; totalFocos: number; intensityNorm: number; rampHex: string; isTopYear: boolean; rank: number }>
  >(() => {
    const hist = this.historialAnual();
    const byYear = new Map(hist?.porAnio.map((y) => [y.anio, y]) || []);
    const ranked = (hist?.porAnio || [])
      .filter((y) => y.totalFocos > 0)
      .slice()
      .sort((a, b) => b.totalFocos - a.totalFocos);
    const rankMap = new Map<number, number>();
    ranked.forEach((y, idx) => rankMap.set(y.anio, idx + 1));
    const maxYear = Math.max(1, ...ranked.map((y) => y.totalFocos));

    return this.years.map((anio) => {
      const total = byYear.get(anio)?.totalFocos || 0;
      const norm = computeThermalLogNorm(total, maxYear);
      const rank = rankMap.get(anio) || 0;
      return {
        anio,
        totalFocos: total,
        intensityNorm: norm,
        rampHex: computeThermalRampColor(norm),
        isTopYear: rank > 0 && rank <= 3,
        rank
      };
    });
  });

  readonly displayedListRows = computed<ListRow[]>(() =>
    this.mapFeaturesToListRows(this.sortedListFeatures().slice(0, 1500))
  );

  constructor() {
    effect(() => {
      if (this.open()) {
        document.body.classList.add('tl-open');
      } else {
        document.body.classList.remove('tl-open');
        this.hidePopovers();
        this.stopPlayback();
      }
    });

    effect(() => {
      const selMonth = this.selectedMonth();
      if (this.open() && selMonth > 0) {
        setTimeout(() => {
          const activeMonth = this.monthList?.nativeElement.querySelector('[aria-pressed="true"]');
          activeMonth?.scrollIntoView({ inline: 'center', block: 'nearest' });
        }, 20);
      }
    });

    effect(() => {
      const selDay = this.selectedDay();
      if (this.open() && selDay > 0) {
        setTimeout(() => {
          const activeDay = this.dayList?.nativeElement.querySelector('[aria-pressed="true"]:not(.all)');
          activeDay?.scrollIntoView({ inline: 'center', block: 'nearest' });
        }, 20);
      }
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (!target.closest('#tlYp, #tlMn, [data-a="ypick"], [data-a="more"]')) {
      this.hidePopovers();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.hidePopovers();
  }

  ngOnDestroy(): void {
    this.stopPlayback();
    this.dlSub?.unsubscribe();
    document.body.classList.remove('tl-open');
  }

  private mapFeaturesToListRows(features: HotspotFeature[], includeMetrics = true): ListRow[] {
    const cols = this.i18n.cols();
    const sevNames = this.i18n.sevNames();
    const srcNames = this.i18n.srcNames();
    const rows: ListRow[] = [];

    for (const f of features) {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      const [y, m, d] = p.date.split('-');
      const values: Record<string, string | number> = {
        [cols[0]]: `${d}/${m}/${y}`,
        [cols[1]]: p.time,
        [cols[2]]: p.country || p.region,
        [cols[3]]: lat,
        [cols[4]]: lng,
        [cols[5]]: sevNames[p.sev],
        [cols[6]]: srcNames[p.src] || srcNames.veg
      };
      if (includeMetrics) {
        values[cols[7]] = p.frp;
        values[cols[8]] = p.sensor;
      }
      rows.push({ sev: p.sev, values });
    }
    return rows;
  }

  private hidePopovers(): void {
    this.yearPopOpen.set(false);
    this.moreMenuOpen.set(false);
  }

  toggleYearPop(event: Event): void {
    event.stopPropagation();
    const next = !this.yearPopOpen();
    this.hidePopovers();
    this.yearPopOpen.set(next);
    if (next) {
      setTimeout(() => {
        const cur = this.yearList?.nativeElement.querySelector('[aria-pressed="true"]');
        cur?.scrollIntoView({ block: 'nearest' });
      }, 20);
    }
  }

  toggleMoreMenu(event: Event): void {
    event.stopPropagation();
    const next = !this.moreMenuOpen();
    this.hidePopovers();
    this.moreMenuOpen.set(next);
  }

  isFutureMonth(monthNum: number): boolean {
    return this.selectedYear() === this.currentYear && monthNum > this.currentMonth;
  }

  isFutureDay(dayNum: number): boolean {
    return (
      this.selectedYear() === this.currentYear &&
      this.selectedMonth() === this.currentMonth &&
      dayNum > this.currentDay
    );
  }

  onStepYear(delta: number): void {
    const next = Math.max(2000, Math.min(this.currentYear, this.selectedYear() + delta));
    if (next !== this.selectedYear()) {
      this.onPickYear(next);
    }
  }

  onPickYear(year: number): void {
    this.hidePopovers();
    this.stopPlayback();
    this.selectYear.emit(year);
  }

  onPickMonth(monthNum: number): void {
    if (this.isFutureMonth(monthNum)) return;
    this.hidePopovers();
    this.stopPlayback();
    this.selectMonth.emit(monthNum);
  }

  onPickDay(dayNum: number): void {
    if (dayNum > 0 && this.isFutureDay(dayNum)) return;
    this.hidePopovers();
    this.stopPlayback();
    this.selectDay.emit(dayNum);
  }

  onMenuHistory(): void {
    this.hidePopovers();
    this.openHistory.emit();
  }

  onMenuPlay(): void {
    this.hidePopovers();
    this.togglePlay();
  }

  onMenuPeak(): void {
    this.hidePopovers();
    this.goPeak.emit();
  }

  onMenuList(): void {
    this.hidePopovers();
    this.openListDialog();
  }

  onMenuExit(): void {
    this.hidePopovers();
    this.stopPlayback();
    this.exitTimeline.emit();
  }

  togglePlay(): void {
    if (this.playing()) {
      this.stopPlayback();
      return;
    }

    const lastDay =
      this.selectedYear() === this.currentYear && this.selectedMonth() === this.currentMonth
        ? this.currentDay
        : this.daysInSelectedMonth();

    let cur = this.selectedDay() && this.selectedDay() < lastDay ? this.selectedDay() : 1;
    this.playing.set(true);
    this.playingChange.emit(true);
    this.playStep.emit(cur);

    this.playTimer = setInterval(() => {
      if (cur >= lastDay) {
        this.stopPlayback();
        this.playStep.emit(0);
        this.askDlg?.nativeElement.showModal();
        return;
      }
      cur++;
      this.playStep.emit(cur);
    }, 900);
  }

  stopPlayback(): void {
    const wasPlaying = this.playing();
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    this.playing.set(false);
    if (wasPlaying) {
      this.playingChange.emit(false);
    }
  }

  closeAskDialog(): void {
    this.askDlg?.nativeElement.close();
  }

  openListDialog(): void {
    this.askDlg?.nativeElement.close();
    this.listDayFilter.set(this.selectedDay());
    this.listOpen.set(true);
    this.listDlg?.nativeElement.showModal();
  }

  closeListDialog(): void {
    this.listOpen.set(false);
    this.listDlg?.nativeElement.close();
  }

  onListDialogClosed(): void {
    this.listOpen.set(false);
  }

  onListDayChange(event: Event): void {
    this.listDayFilter.set(+(event.target as HTMLSelectElement).value);
  }

  downloadList(format: 'xlsx' | 'doc' | 'csv' | 'json'): void {
    const cols = this.i18n.cols();
    const rows = this.mapFeaturesToListRows(this.sortedListFeatures()).map((r) => r.values);
    const mPad = String(this.selectedMonth()).padStart(2, '0');
    const dPad = this.listDayFilter() ? `-${String(this.listDayFilter()).padStart(2, '0')}` : '';
    const filename = `iris-incendios-${this.selectedYear()}-${mPad}${dPad}`;
    const title = `IRIS · ${this.i18n.l('Incendios', 'Fires')} ${this.i18n.meses()[this.selectedMonth() - 1]} ${this.selectedYear()}`;
    this.csvExport.exportTable(format, rows, cols, filename, title);
  }

  openDlDialog(): void {
    this.hidePopovers();
    const box = this.mapbox.getAreaBox();
    if (!box) {
      this.notifyToast.emit({
        message: this.i18n.l(
          'Primero selecciona una región: haz clic en el mapa (o búscala) y vuelve a pulsar Descargar.',
          'First select a region: click on the map (or search for one), then press Download again.'
        )
      });
      return;
    }

    this.dlBox.set(box);
    this.dlRegionName.set(this.mapbox.areaName() || this.i18n.translate('Región seleccionada'));

    if (this.open()) {
      const y = this.selectedYear();
      const mStr = String(this.selectedMonth()).padStart(2, '0');
      const lastDay = this.daysInSelectedMonth();
      const endIsoRaw = `${y}-${mStr}-${String(lastDay).padStart(2, '0')}`;
      const endIso = endIsoRaw > this.todayIso ? this.todayIso : endIsoRaw;
      this.dlFrom.set(`${y}-${mStr}-01`);
      this.dlTo.set(endIso);
    } else {
      this.dlFrom.set(new Date((this.todayDay - 29) * 864e5).toISOString().slice(0, 10));
      this.dlTo.set(this.todayIso);
    }

    this.dlMsg.set('');
    this.dlBusy.set(false);
    this.dlDlg?.nativeElement.showModal();
  }

  closeDlDialog(): void {
    this.dlDlg?.nativeElement.close();
  }

  onDlDialogClosed(): void {
    this.dlSub?.unsubscribe();
    this.dlBusy.set(false);
  }

  onDlDateChange(edge: 'from' | 'to', event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    if (edge === 'from') this.dlFrom.set(val);
    else this.dlTo.set(val);
  }

  applyDlPreset(daysCount: number): void {
    const startIso = new Date((this.todayDay - (daysCount - 1)) * 864e5).toISOString().slice(0, 10);
    this.dlFrom.set(startIso < '2000-11-01' ? '2000-11-01' : startIso);
    this.dlTo.set(this.todayIso);
  }

  runRegionDownload(format: 'report' | 'csv' | 'xlsx' | 'json'): void {
    const box = this.dlBox();
    if (!box || this.dlBusy()) return;

    const fromStr = this.dlFrom();
    const toStr = this.dlTo();
    const d0 = fromStr ? dayNumFromUtcDate(fromStr) : NaN;
    let d1 = toStr ? dayNumFromUtcDate(toStr) : NaN;

    if (Number.isNaN(d0) || Number.isNaN(d1)) {
      this.dlMsg.set(this.i18n.l('Elige las dos fechas.', 'Pick both dates.'));
      return;
    }
    if (d0 > d1) {
      this.dlMsg.set(this.i18n.l('La fecha inicial debe ser anterior a la final.', 'The start date must be before the end date.'));
      return;
    }
    if (d1 - d0 > 1095) {
      this.dlMsg.set(this.i18n.l('El máximo es de 3 años por descarga.', 'The maximum is 3 years per download.'));
      return;
    }
    d1 = Math.min(d1, this.todayDay);

    const [west, south, east, north] = box;
    const scope = this.mapbox.areaScope();
    const scopedPais = scope?.pais;
    const queries: IncendiosQueryParams[] = [];

    if (d0 === d1) {
      queries.push({
        fecha: fromStr,
        pais: scopedPais,
        ...(scope?.isCountry ? {} : { north, south, east, west }),
        limite: 100000,
        compact: 1
      });
    } else {
      const startDate = new Date(d0 * 864e5);
      const endDate = new Date(d1 * 864e5);
      let y = startDate.getUTCFullYear();
      let m = startDate.getUTCMonth() + 1;
      const endY = endDate.getUTCFullYear();
      const endM = endDate.getUTCMonth() + 1;

      while (y < endY || (y === endY && m <= endM)) {
        queries.push({
          anioConsulta: y,
          mesConsulta: m,
          pais: scopedPais,
          ...(scope?.isCountry ? {} : { north, south, east, west }),
          limite: 100000,
          compact: 1
        });
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }

    this.dlSub?.unsubscribe();
    this.dlBusy.set(true);
    this.dlMsg.set(
      this.i18n.l(
        `Consultando datos satelitales (${queries.length} ${queries.length === 1 ? 'periodo' : 'periodos'})…`,
        `Querying satellite data (${queries.length} ${queries.length === 1 ? 'period' : 'periods'})…`
      )
    );

    this.dlSub = from(queries)
      .pipe(
        mergeMap(
          (params) => this.api.fetchIncendiosRaw(params).pipe(catchError(() => of(null))),
          3
        ),
        toArray()
      )
      .subscribe({
        next: (responses) => {
          this.dlBusy.set(false);
          const valid = responses.filter((r): r is NonNullable<typeof r> => r !== null);
          const fc = this.api.mapApiResponsesToGeoJson(valid);
          const regionFeatures = fc.features
            .filter((f) => {
              const day = f.properties.day;
              const [lng, lat] = f.geometry.coordinates;
              return day >= d0 && day <= d1 && this.mapbox.isPointInArea(lng, lat, box);
            })
            .sort((a, b) =>
              a.properties.day - b.properties.day || (a.properties.time < b.properties.time ? -1 : 1)
            );

          if (!regionFeatures.length) {
            this.dlMsg.set(
              this.i18n.l(
                'No hay focos en esa región y periodo. Prueba con otro rango de fechas.',
                'No hotspots in that region and period. Try another date range.'
              )
            );
            return;
          }

          const name = this.dlRegionName();
          const slug =
            name
              .split(',')[0]
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/[^\w]+/g, '-')
              .replace(/^-|-$/g, '')
              .toLowerCase() || 'region';
          const filenameBase = `iris-${slug}-${fromStr}_${toStr}`;

          if (format === 'report') {
            this.csvExport.exportRegionAnalysisHtml(
              regionFeatures,
              { name, box, from: fromStr, to: toStr, d0, d1 },
              filenameBase
            );
          } else {
            const cols = this.i18n.cols();
            const rows = this.mapFeaturesToListRows(regionFeatures, true).map((r) => r.values);
            const title = `IRIS · ${name} (${fromStr} → ${toStr})`;
            this.csvExport.exportTable(format, rows, cols, filenameBase, title);
          }

          this.dlMsg.set(
            this.i18n.l(
              `Descarga lista ✓ (${regionFeatures.length.toLocaleString(this.i18n.locale())} focos)`,
              `Download ready ✓ (${regionFeatures.length.toLocaleString(this.i18n.locale())} hotspots)`
            )
          );
        },
        error: () => {
          this.dlBusy.set(false);
          this.dlMsg.set(
            this.i18n.l(
              'Error consultando el servidor. Inténtalo de nuevo.',
              'Error querying the server. Please try again.'
            )
          );
        }
      });
  }
}

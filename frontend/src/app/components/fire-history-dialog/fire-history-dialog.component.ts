import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { Subscription, catchError, forkJoin, map, of } from 'rxjs';
import { AreaFilterScope, HistorialAnualResponse, PaisCatalogoItem } from '../../core/models';
import {
  CsvExportService,
  I18nService,
  IncendiosApiService,
  SERIES_ACCENT_COLORS,
  THERMAL_LEGEND_STOPS,
  buildMonthRangeList,
  computeThermalLogNorm,
  computeThermalRampColor,
  sumMonthsInRange
} from '../../core/services';

export interface HistoryTargetOption {
  key: string;
  label: string;
  searchText: string;
  scope: AreaFilterScope | null;
}

export interface HistorySeriesEntry {
  key: string;
  label: string;
  color: string;
  scope: AreaFilterScope | null;
  data: HistorialAnualResponse;
}

export interface PeriodComparisonItem {
  id: string;
  seriesKey: string;
  countryLabel: string;
  year: number;
  title: string;
  color: string;
  scope: AreaFilterScope | null;
  monthlyCounts: number[];
  rangeTotal: number;
  annualTotal: number;
  histAvgRange: number;
  vsHistPct: number | null;
  vsFirstPct: number | null;
  peakMonthInRange: number;
  peakMonthCount: number;
  isFocusYear: boolean;
}

export interface ApplyPeriodEvent {
  scope: AreaFilterScope | null;
  year: number;
  month: number;
}

function stripAccents(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function createRegionDisplayNames(lang: string): Intl.DisplayNames | null {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      return new Intl.DisplayNames([lang], { type: 'region' });
    }
  } catch {
    // Ignore unsupported Intl.DisplayNames locales
  }
  return null;
}

function filterTargetOptions(
  list: ReadonlyArray<HistoryTargetOption>,
  rawQuery: string,
  limit = 12
): { items: HistoryTargetOption[]; totalMatches: number } {
  const q = stripAccents(rawQuery);
  if (!q) {
    return { items: list.slice(0, limit), totalMatches: list.length };
  }

  const prefixMatches: HistoryTargetOption[] = [];
  const otherMatches: HistoryTargetOption[] = [];

  for (const opt of list) {
    const labelNorm = stripAccents(opt.label);
    const words = opt.searchText.split(/[\s,()]+/);
    if (labelNorm.startsWith(q) || words.some((w) => w.startsWith(q))) {
      prefixMatches.push(opt);
    } else if (opt.searchText.includes(q)) {
      otherMatches.push(opt);
    }
  }

  const merged = [...prefixMatches, ...otherMatches];
  return { items: merged.slice(0, limit), totalMatches: merged.length };
}

@Component({
  selector: 'app-fire-history-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './fire-history-dialog.component.html'
})
export class FireHistoryDialogComponent implements OnDestroy {
  readonly i18n = inject(I18nService);
  private readonly api = inject(IncendiosApiService);
  private readonly csvExport = inject(CsvExportService);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  protected readonly Math = Math;

  readonly mapScope = input<AreaFilterScope | null>(null);
  readonly initialYear = input<number>(2026);
  readonly initialMonth = input<number>(11);

  readonly applyToMap = output<ApplyPeriodEvent>();
  readonly notifyToast = output<{ message: string; isError?: boolean }>();

  @ViewChild('histDlg') histDlg?: ElementRef<HTMLDialogElement>;
  @ViewChild('primaryInputEl') primaryInputEl?: ElementRef<HTMLInputElement>;
  @ViewChild('compareInputEl') compareInputEl?: ElementRef<HTMLInputElement>;

  readonly nowUtc = new Date();
  readonly currentYear = Math.max(2026, this.nowUtc.getUTCFullYear());
  readonly years: number[] = Array.from({ length: this.currentYear - 1999 }, (_, i) => 2000 + i);
  readonly monthIndices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  readonly legendStops = THERMAL_LEGEND_STOPS;

  readonly countries = signal<PaisCatalogoItem[]>([]);
  readonly loading = signal<boolean>(false);
  readonly scaleMode = signal<'abs' | 'norm'>('abs');

  // Estado borrador (NO dispara consultas mientras el usuario configura filtros)
  readonly draftPrimaryKey = signal<string>('__GLOBAL__');
  readonly draftCompareKeys = signal<string[]>([]);

  // Autocompletado buscable de países (evita desplegar 250+ opciones de golpe)
  readonly primaryQuery = signal<string>('');
  readonly primaryOpen = signal<boolean>(false);
  readonly primaryHiIdx = signal<number>(0);

  readonly compareQuery = signal<string>('');
  readonly compareOpen = signal<boolean>(false);
  readonly compareHiIdx = signal<number>(0);

  // Filtros temporales locales en memoria (0 peticiones HTTP)
  readonly focusYear = signal<number>(this.currentYear);
  readonly compareYears = signal<number[]>([]);
  readonly rangeFrom = signal<number>(1);
  readonly rangeTo = signal<number>(12);

  // Resultados cargados únicamente al pulsar Consultar (o al abrir la primera vez)
  readonly loadedSeries = signal<HistorySeriesEntry[]>([]);
  readonly activeTargetsKey = signal<string>('');

  private countriesSub: Subscription | null = null;
  private querySub: Subscription | null = null;
  private cachedMapScope: AreaFilterScope | null = null;

  readonly quickRangePresets = [
    { id: 'full', from: 1, to: 12, es: 'Todo el año (Ene–Dic)', en: 'Full year (Jan–Dec)' },
    { id: 't1', from: 1, to: 4, es: 'Ene–Abr', en: 'Jan–Apr' },
    { id: 't2', from: 5, to: 8, es: 'May–Ago', en: 'May–Aug' },
    { id: 't3', from: 9, to: 12, es: 'Sep–Dic', en: 'Sep–Dec' },
    { id: 'peak', from: 7, to: 10, es: 'Jul–Oct', en: 'Jul–Oct' }
  ] as const;

  readonly selectedMonths = computed<number[]>(() => buildMonthRangeList(this.rangeFrom(), this.rangeTo()));
  readonly selectedMonthSet = computed<Set<number>>(() => new Set(this.selectedMonths()));
  readonly isComparingYears = computed<boolean>(() => this.compareYears().length > 0);
  readonly activeYears = computed<number[]>(() => [this.focusYear(), ...this.compareYears()]);

  readonly rangeLabel = computed<string>(() => {
    const names = this.i18n.meses();
    const from = this.rangeFrom();
    const to = this.rangeTo();
    if (from === 1 && to === 12) return this.i18n.l('Todo el año (Ene–Dic)', 'Full year (Jan–Dec)');
    if (from === to) return names[from - 1];
    return `${names[from - 1].slice(0, 3)}–${names[to - 1].slice(0, 3)}`;
  });

  readonly targetCatalog = computed<HistoryTargetOption[]>(() => {
    const lang = this.i18n.lang();
    const dnEs = createRegionDisplayNames('es');
    const dnEn = createRegionDisplayNames('en');
    const opts: HistoryTargetOption[] = [];
    const ms = this.cachedMapScope || this.mapScope();
    if (ms && ms.name) {
      opts.push({
        key: '__MAP_AREA__',
        label: `📍 ${ms.name}`,
        searchText: stripAccents(`${ms.name} ${ms.pais || ''} mapa zona`),
        scope: ms
      });
    }
    const globalLabel = this.i18n.l('🌍 Global (todo el planeta)', '🌍 Global (worldwide)');
    opts.push({
      key: '__GLOBAL__',
      label: globalLabel,
      searchText: 'global worldwide mundo planeta tierra all earth',
      scope: null
    });
    for (const c of this.countries()) {
      const code = c.codigo;
      const iso2 = (c.iso2 || '').toUpperCase();
      let localizedEs = '';
      let localizedEn = '';
      if (iso2) {
        try {
          localizedEs = dnEs?.of(iso2) || '';
          localizedEn = dnEn?.of(iso2) || '';
        } catch {
          // Ignore invalid ISO2 lookup
        }
      }
      const display = lang === 'es' ? localizedEs || c.nombre : c.nombre;
      opts.push({
        key: `COUNTRY:${code}`,
        label: display,
        searchText: stripAccents(`${display} ${c.nombre} ${c.nombreGcs || ''} ${localizedEs} ${localizedEn} ${code} ${iso2}`),
        scope: { name: display, pais: code, isCountry: true, bbox: null }
      });
    }
    return opts;
  });

  readonly targetCatalogMap = computed<Map<string, HistoryTargetOption>>(() => {
    const map = new Map<string, HistoryTargetOption>();
    for (const opt of this.targetCatalog()) map.set(opt.key, opt);
    return map;
  });

  readonly selectedPrimaryLabel = computed<string>(
    () => this.targetCatalogMap().get(this.draftPrimaryKey())?.label || 'Global'
  );

  readonly primaryFilterResult = computed(() =>
    filterTargetOptions(this.targetCatalog(), this.primaryQuery(), 12)
  );

  readonly compareSelectOptions = computed<HistoryTargetOption[]>(() => {
    const primary = this.draftPrimaryKey();
    const chosen = new Set(this.draftCompareKeys());
    return this.targetCatalog().filter((o) => o.key !== primary && !chosen.has(o.key));
  });

  readonly compareFilterResult = computed(() =>
    filterTargetOptions(this.compareSelectOptions(), this.compareQuery(), 12)
  );

  readonly draftCompareChips = computed<HistoryTargetOption[]>(() => {
    const map = this.targetCatalogMap();
    return this.draftCompareKeys()
      .map((k) => map.get(k))
      .filter((x): x is HistoryTargetOption => Boolean(x));
  });

  readonly availableCompareYears = computed<number[]>(() => {
    const taken = new Set(this.activeYears());
    return this.years
      .slice()
      .reverse()
      .filter((y) => !taken.has(y));
  });

  readonly quickSuggestedCompareYear = computed<{ label: string; year: number } | null>(() => {
    const primary = this.loadedSeries()[0];
    const focus = this.focusYear();
    if (primary?.data.anioPico?.anio && primary.data.anioPico.anio !== focus) {
      return {
        label: `${this.i18n.l('vs año pico', 'vs peak year')} (${primary.data.anioPico.anio})`,
        year: primary.data.anioPico.anio
      };
    }
    const prev = focus > 2000 ? focus - 1 : 2025;
    if (prev !== focus) {
      return {
        label: `vs ${prev}`,
        year: prev
      };
    }
    return null;
  });

  readonly draftTargetsKey = computed<string>(() =>
    [this.draftPrimaryKey(), ...this.draftCompareKeys()].join('|')
  );

  readonly hasPendingQueryChanges = computed<boolean>(
    () => this.draftTargetsKey() !== this.activeTargetsKey() || this.loadedSeries().length === 0
  );

  // Resumen por país/zona (modo estándar cuando no hay comparación entre años distintos)
  readonly seriesSummaries = computed(() => {
    const series = this.loadedSeries();
    const months = this.selectedMonths();
    const fYear = this.focusYear();
    const primaryRangeTotal = series.length
      ? series[0].data.porAnio.reduce((acc, y) => acc + sumMonthsInRange(y.meses, months), 0)
      : 0;

    return series.map((s, idx) => {
      const yearValues = s.data.porAnio.map((y) => ({
        anio: y.anio,
        rangeTotal: sumMonthsInRange(y.meses, months),
        fullTotal: y.totalFocos
      }));

      const totalRange = yearValues.reduce((acc, y) => acc + y.rangeTotal, 0);
      const nonZeroPast = yearValues.filter((y) => y.anio < this.currentYear && y.rangeTotal > 0);
      const baseList = nonZeroPast.length ? nonZeroPast : yearValues.filter((y) => y.rangeTotal > 0);
      const avgRange = baseList.length
        ? Math.round(baseList.reduce((acc, y) => acc + y.rangeTotal, 0) / baseList.length)
        : 0;

      const sorted = yearValues
        .filter((y) => y.rangeTotal > 0)
        .slice()
        .sort((a, b) => b.rangeTotal - a.rangeTotal);
      const peakYear = sorted[0] || null;
      const focusObj = yearValues.find((y) => y.anio === fYear) || { anio: fYear, rangeTotal: 0, fullTotal: 0 };
      const focusDeltaPct =
        avgRange > 0 && focusObj.rangeTotal > 0
          ? Math.round(((focusObj.rangeTotal - avgRange) / avgRange) * 100)
          : null;
      const focusRankIdx = sorted.findIndex((y) => y.anio === fYear);

      const vsPrimaryPct =
        idx > 0 && primaryRangeTotal > 0
          ? Math.round(((totalRange - primaryRangeTotal) / primaryRangeTotal) * 100)
          : null;

      return {
        ...s,
        isPrimary: idx === 0,
        totalRange,
        avgRange,
        peakYear,
        focusTotal: focusObj.rangeTotal,
        focusDeltaPct,
        focusRank: focusRankIdx >= 0 ? focusRankIdx + 1 : null,
        yearsWithData: sorted.length,
        vsPrimaryPct,
        peakSeasonMonth: s.data.mesPicoEstacional?.mes || 0,
        peakSeasonAvg: Math.round(s.data.mesPicoEstacional?.promedioAnual || 0),
        topYears: sorted.slice(0, 4)
      };
    });
  });

  // Tarjetas & series por (País × Año) cuando compareYears() tiene años seleccionados (0 peticiones extra)
  readonly periodComparisonItems = computed<PeriodComparisonItem[]>(() => {
    const series = this.loadedSeries();
    const yearsList = this.activeYears();
    const months = this.selectedMonths();
    const fYear = this.focusYear();
    if (!series.length || yearsList.length < 2) return [];

    const rawItems: Array<Omit<PeriodComparisonItem, 'vsFirstPct'>> = [];
    let colorIdx = 0;

    for (const s of series) {
      const nonZeroPast = s.data.porAnio.filter((y) => y.anio < this.currentYear && sumMonthsInRange(y.meses, months) > 0);
      const baseList = nonZeroPast.length
        ? nonZeroPast
        : s.data.porAnio.filter((y) => sumMonthsInRange(y.meses, months) > 0);
      const histAvgRange = baseList.length
        ? Math.round(baseList.reduce((acc, y) => acc + sumMonthsInRange(y.meses, months), 0) / baseList.length)
        : 0;

      for (const year of yearsList) {
        const yObj = s.data.porAnio.find((item) => item.anio === year);
        const monthlyCounts = this.monthIndices.map((_, idx) => Number(yObj?.meses[idx] || 0));
        const rangeTotal = sumMonthsInRange(monthlyCounts, months);
        const annualTotal = yObj?.totalFocos || 0;
        const vsHistPct =
          histAvgRange > 0 && rangeTotal > 0 ? Math.round(((rangeTotal - histAvgRange) / histAvgRange) * 100) : null;

        let peakMonthInRange = months[0] || 1;
        let peakMonthCount = -1;
        for (const m of months) {
          const cnt = monthlyCounts[m - 1] || 0;
          if (cnt > peakMonthCount) {
            peakMonthCount = cnt;
            peakMonthInRange = m;
          }
        }

        const shortCountry = s.label.split(',')[0];
        const title = series.length === 1 ? `${shortCountry} · ${year}` : `${shortCountry} (${year})`;
        const color = SERIES_ACCENT_COLORS[colorIdx % SERIES_ACCENT_COLORS.length];
        colorIdx++;

        rawItems.push({
          id: `${s.key}:${year}`,
          seriesKey: s.key,
          countryLabel: s.label,
          year,
          title,
          color,
          scope: s.scope,
          monthlyCounts,
          rangeTotal,
          annualTotal,
          histAvgRange,
          vsHistPct,
          peakMonthInRange,
          peakMonthCount: Math.max(0, peakMonthCount),
          isFocusYear: year === fYear
        });
      }
    }

    const baseTotal = rawItems[0]?.rangeTotal || 0;
    return rawItems.map((item, idx) => ({
      ...item,
      vsFirstPct:
        idx > 0 && baseTotal > 0 ? Math.round(((item.rangeTotal - baseTotal) / baseTotal) * 100) : null
    }));
  });

  // Gráfica comparativa mes a mes entre los años seleccionados
  readonly monthlyComparisonChart = computed(() => {
    const items = this.periodComparisonItems();
    const activeSet = this.selectedMonthSet();
    const mode = this.scaleMode();
    if (!items.length) return { cols: [], maxAbs: 1 };

    const itemMaxes = items.map((it) => Math.max(1, ...it.monthlyCounts));
    const maxAbs = Math.max(1, ...itemMaxes);
    const monthsNames = this.i18n.meses();

    const cols = this.monthIndices.map((mes, idx) => {
      const bars = items.map((it, iIdx) => {
        const val = it.monthlyCounts[idx] || 0;
        const denom = mode === 'norm' ? itemMaxes[iIdx] : maxAbs;
        const norm = computeThermalLogNorm(val, denom);
        const pct = val > 0 ? Math.max(6, Math.round((mode === 'norm' ? val / denom : norm) * 100)) : 2;
        return {
          id: it.id,
          title: it.title,
          value: val,
          pct,
          color: it.color
        };
      });

      const primaryVal = bars[0]?.value || 0;
      const labelShort = monthsNames[idx].slice(0, 3);
      return {
        mes,
        shortLabel: labelShort,
        fullLabel: monthsNames[idx],
        inRange: activeSet.has(mes),
        bars,
        primaryVal,
        tooltip: `${monthsNames[idx]}: ${bars
          .map((b) => `${b.title} ${b.value.toLocaleString(this.i18n.locale())}`)
          .join(' | ')}`
      };
    });

    return { cols, maxAbs };
  });

  readonly yearlyChartData = computed(() => {
    const series = this.loadedSeries();
    const months = this.selectedMonths();
    const mode = this.scaleMode();
    const compareMap = new Map<number, string>();
    this.compareYears().forEach((y, idx) => {
      compareMap.set(y, SERIES_ACCENT_COLORS[(idx + 1) % SERIES_ACCENT_COLORS.length]);
    });
    if (!series.length) return { rows: [], maxAbs: 1 };

    const seriesMaxes = series.map((s) =>
      Math.max(1, ...s.data.porAnio.map((y) => sumMonthsInRange(y.meses, months)))
    );
    const maxAbs = Math.max(1, ...seriesMaxes);

    const rows = this.years.map((anio) => {
      const bars = series.map((s, sIdx) => {
        const yObj = s.data.porAnio.find((item) => item.anio === anio);
        const val = yObj ? sumMonthsInRange(yObj.meses, months) : 0;
        const denom = mode === 'norm' ? seriesMaxes[sIdx] : maxAbs;
        const norm = computeThermalLogNorm(val, denom);
        const pct = val > 0 ? Math.max(6, Math.round((mode === 'norm' ? val / denom : norm) * 100)) : 2;
        const rampColor = series.length === 1 ? computeThermalRampColor(norm) : s.color;
        return {
          key: s.key,
          label: s.label,
          value: val,
          pct,
          color: rampColor
        };
      });
      const rangeLbl = this.rangeLabel();
      return {
        anio,
        bars,
        primaryValue: bars[0]?.value || 0,
        tooltip: `${anio} (${rangeLbl}): ${bars
          .map((b) => `${b.label.split(',')[0]} ${b.value.toLocaleString(this.i18n.locale())}`)
          .join(' | ')}`,
        isComparedYear: compareMap.has(anio),
        compareColor: compareMap.get(anio) || '',
        isPeakPrimary:
          series.length === 1 &&
          bars[0]?.value > 0 &&
          bars[0].value === seriesMaxes[0]
      };
    });

    return { rows, maxAbs };
  });

  // Matriz de 12 meses alineada: si hay comparación por años, muestra conteos exactos por (País · Año); si no, el promedio estacional
  readonly matrixRows = computed(() => {
    const activeMonths = this.selectedMonthSet();
    const monthsNames = this.i18n.meses();

    if (this.isComparingYears()) {
      const items = this.periodComparisonItems();
      const baseCounts = items[0]?.monthlyCounts || [];
      return items.map((it, rowIdx) => {
        const maxMonthVal = Math.max(1, ...it.monthlyCounts);
        const cells = this.monthIndices.map((mNum, idx) => {
          const val = it.monthlyCounts[idx] || 0;
          const norm = computeThermalLogNorm(val, maxMonthVal);
          const baseVal = baseCounts[idx] || 0;
          const deltaPct =
            rowIdx > 0 && baseVal > 0 ? Math.round(((val - baseVal) / baseVal) * 100) : null;
          return {
            mes: mNum,
            shortLabel: monthsNames[idx].slice(0, 3),
            fullLabel: monthsNames[idx],
            primaryNum: val.toLocaleString(this.i18n.locale()),
            subText:
              deltaPct !== null
                ? `${deltaPct >= 0 ? '+' : ''}${deltaPct}% vs ${items[0].year}`
                : it.peakMonthInRange === mNum && val > 0
                  ? `${this.i18n.l('Pico', 'Peak')}`
                  : '—',
            inRange: activeMonths.has(mNum),
            isPeakCell: val > 0 && val === maxMonthVal,
            norm,
            rampHex: computeThermalRampColor(norm),
            tooltip: `${it.title} · ${monthsNames[idx]}: ${val.toLocaleString(this.i18n.locale())} ${this.i18n.l('focos', 'hotspots')}`
          };
        });
        return {
          key: it.id,
          label: it.title,
          color: it.color,
          cells
        };
      });
    }

    const series = this.loadedSeries();
    return series.map((s) => {
      const avgs = s.data.porMes.map((m) => m.promedioAnual || 0);
      const maxAvg = Math.max(1, ...avgs);
      const topSet = new Set((s.data.topMesesEstacionales || []).slice(0, 3).map((m) => m.mes));
      const cells = this.monthIndices.map((mNum, idx) => {
        const item = s.data.porMes[idx];
        const avg = Math.round(item?.promedioAnual || 0);
        const norm = computeThermalLogNorm(item?.promedioAnual || 0, maxAvg);
        return {
          mes: mNum,
          shortLabel: monthsNames[idx].slice(0, 3),
          fullLabel: monthsNames[idx],
          primaryNum: `~${avg.toLocaleString(this.i18n.locale())}`,
          subText:
            item?.anioPico && item.anioPico > 0
              ? `${this.i18n.l('Pico', 'Peak')}: ${item.anioPico}`
              : '—',
          inRange: activeMonths.has(mNum),
          isPeakCell: topSet.has(mNum),
          norm,
          rampHex: computeThermalRampColor(norm),
          tooltip: `${s.label} · ${monthsNames[idx]}: ~${avg.toLocaleString(this.i18n.locale())}/${this.i18n.l('año', 'yr')}`
        };
      });
      return {
        key: s.key,
        label: s.label,
        color: s.color,
        cells
      };
    });
  });

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (!target.closest('.hd-combo-primary')) {
      this.closePrimaryDropdown();
    }
    if (!target.closest('.hd-combo-compare')) {
      this.closeCompareDropdown();
    }
  }

  ngOnDestroy(): void {
    this.countriesSub?.unsubscribe();
    this.querySub?.unsubscribe();
  }

  openModal(explicitScope?: AreaFilterScope | null): void {
    const scope = explicitScope !== undefined ? explicitScope : this.mapScope();
    this.cachedMapScope = scope;

    if (this.countries().length === 0) {
      this.countriesSub?.unsubscribe();
      this.countriesSub = this.api.fetchCountries().subscribe((list) => {
        this.countries.set(list);
      });
    }

    const hadLoaded = this.loadedSeries().length > 0;
    const hasExplicitMapArea = Boolean(scope && scope.name);
    const nextFocusYear = this.initialYear() || this.currentYear;
    this.focusYear.set(nextFocusYear);
    this.compareYears.update((list) => list.filter((y) => y !== nextFocusYear));
    this.primaryOpen.set(false);
    this.compareOpen.set(false);

    if (!hasExplicitMapArea && hadLoaded) {
      this.histDlg?.nativeElement.showModal();
      return;
    }

    const desiredPrimary = hasExplicitMapArea ? '__MAP_AREA__' : '__GLOBAL__';
    this.draftPrimaryKey.set(desiredPrimary);

    const opt = this.targetCatalogMap().get(desiredPrimary) || {
      key: desiredPrimary,
      label: scope?.name || 'Global',
      searchText: '',
      scope: scope || null
    };

    const cached = this.api.getCachedAnnualHistory(opt.scope);
    if (cached && this.activeTargetsKey() === this.draftTargetsKey() && this.loadedSeries().length > 0) {
      this.histDlg?.nativeElement.showModal();
      return;
    }

    if (cached) {
      this.loadedSeries.set([
        {
          key: opt.key,
          label: opt.label.replace(/^📍\s*|^🌍\s*/u, ''),
          color: SERIES_ACCENT_COLORS[0],
          scope: opt.scope,
          data: cached
        }
      ]);
      this.activeTargetsKey.set(this.draftTargetsKey());
      this.histDlg?.nativeElement.showModal();
      return;
    }

    this.histDlg?.nativeElement.showModal();
    if (hasExplicitMapArea || this.loadedSeries().length === 0) {
      this.runConsultation();
    }
  }

  closeModal(): void {
    this.querySub?.unsubscribe();
    this.loading.set(false);
    this.closePrimaryDropdown();
    this.closeCompareDropdown();
    this.histDlg?.nativeElement.close();
  }

  // ---- Autocompletado País Principal ----
  onPrimaryIconToggle(event: MouseEvent): void {
    event.preventDefault();
    if (this.primaryOpen()) {
      this.closePrimaryDropdown();
      this.primaryInputEl?.nativeElement.blur();
    } else {
      this.primaryInputEl?.nativeElement.focus();
    }
  }

  onPrimaryFocus(): void {
    this.closeCompareDropdown();
    this.primaryQuery.set('');
    this.primaryHiIdx.set(0);
    this.primaryOpen.set(true);
  }

  onPrimaryInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.primaryQuery.set(val);
    this.primaryHiIdx.set(0);
    this.primaryOpen.set(true);
  }

  onPrimaryKeyDown(event: KeyboardEvent): void {
    const items = this.primaryFilterResult().items;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.primaryOpen.set(true);
      if (items.length) {
        this.primaryHiIdx.update((i) => (i + 1) % items.length);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.primaryOpen.set(true);
      if (items.length) {
        this.primaryHiIdx.update((i) => (i - 1 + items.length) % items.length);
      }
    } else if (event.key === 'Enter' && this.primaryOpen()) {
      event.preventDefault();
      const chosen = items[this.primaryHiIdx()] || items[0];
      if (chosen) this.selectPrimaryTarget(chosen);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closePrimaryDropdown();
      this.primaryInputEl?.nativeElement.blur();
    }
  }

  selectPrimaryTarget(opt: HistoryTargetOption): void {
    this.draftPrimaryKey.set(opt.key);
    this.draftCompareKeys.update((list) => list.filter((k) => k !== opt.key));
    this.closePrimaryDropdown();
    this.primaryInputEl?.nativeElement.blur();
  }

  private closePrimaryDropdown(): void {
    this.primaryOpen.set(false);
    this.primaryQuery.set('');
    this.primaryHiIdx.set(0);
  }

  // ---- Autocompletado Países a Comparar ----
  onCompareFocus(): void {
    if (this.draftCompareChips().length >= 3) return;
    this.closePrimaryDropdown();
    this.compareHiIdx.set(0);
    this.compareOpen.set(true);
  }

  onCompareInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.compareQuery.set(val);
    this.compareHiIdx.set(0);
    this.compareOpen.set(true);
  }

  onCompareKeyDown(event: KeyboardEvent): void {
    const items = this.compareFilterResult().items;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.compareOpen.set(true);
      if (items.length) {
        this.compareHiIdx.update((i) => (i + 1) % items.length);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.compareOpen.set(true);
      if (items.length) {
        this.compareHiIdx.update((i) => (i - 1 + items.length) % items.length);
      }
    } else if (event.key === 'Enter' && this.compareOpen()) {
      event.preventDefault();
      const chosen = items[this.compareHiIdx()] || items[0];
      if (chosen) this.selectCompareTarget(chosen);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeCompareDropdown();
      this.compareInputEl?.nativeElement.blur();
    }
  }

  selectCompareTarget(opt: HistoryTargetOption): void {
    if (opt.key === this.draftPrimaryKey() || this.draftCompareKeys().includes(opt.key)) {
      this.closeCompareDropdown();
      return;
    }
    if (this.draftCompareKeys().length >= 3) {
      this.notifyToast.emit({
        message: this.i18n.l(
          'Puedes comparar hasta 4 países o zonas a la vez.',
          'You can compare up to 4 countries or areas at once.'
        )
      });
      this.closeCompareDropdown();
      return;
    }
    this.draftCompareKeys.update((list) => [...list, opt.key]);
    this.closeCompareDropdown();
    this.compareInputEl?.nativeElement.blur();
  }

  private closeCompareDropdown(): void {
    this.compareOpen.set(false);
    this.compareQuery.set('');
    this.compareHiIdx.set(0);
  }

  removeCompareKey(key: string): void {
    this.draftCompareKeys.update((list) => list.filter((k) => k !== key));
    if (this.loadedSeries().some((s) => s.key === key)) {
      this.loadedSeries.update((list) => list.filter((s) => s.key !== key));
      this.activeTargetsKey.set(this.loadedSeries().map((s) => s.key).join('|'));
    }
  }

  // ---- Selector de Año enfoque y Comparar años del mismo país (0 peticiones) ----
  onFocusYearChange(event: Event): void {
    const y = +(event.target as HTMLSelectElement).value;
    this.selectFocusYear(y);
  }

  selectFocusYear(y: number): void {
    if (y >= 2000 && y <= this.currentYear) {
      this.focusYear.set(y);
      this.compareYears.update((list) => list.filter((cy) => cy !== y));
    }
  }

  onAddCompareYearChange(event: Event): void {
    const sel = event.target as HTMLSelectElement;
    const year = +sel.value;
    sel.value = '';
    this.addCompareYear(year);
  }

  addCompareYear(year: number): void {
    if (!Number.isFinite(year) || year < 2000 || year > this.currentYear) return;
    if (year === this.focusYear() || this.compareYears().includes(year)) return;
    if (this.compareYears().length >= 3) {
      this.notifyToast.emit({
        message: this.i18n.l(
          'Puedes comparar hasta 4 años a la vez.',
          'You can compare up to 4 years at once.'
        )
      });
      return;
    }
    this.compareYears.update((list) => [...list, year]);
  }

  removeCompareYear(year: number): void {
    this.compareYears.update((list) => list.filter((y) => y !== year));
  }

  onRangeFromChange(event: Event): void {
    const m = +(event.target as HTMLSelectElement).value;
    if (m >= 1 && m <= 12) this.rangeFrom.set(m);
  }

  onRangeToChange(event: Event): void {
    const m = +(event.target as HTMLSelectElement).value;
    if (m >= 1 && m <= 12) this.rangeTo.set(m);
  }

  applyQuickRange(from: number, to: number): void {
    this.rangeFrom.set(from);
    this.rangeTo.set(to);
  }

  onSelectMonthInMatrix(monthNum: number): void {
    const from = this.rangeFrom();
    const to = this.rangeTo();
    if (from === 1 && to === 12) {
      this.rangeFrom.set(monthNum);
      this.rangeTo.set(monthNum);
    } else if (from === to && monthNum !== from) {
      this.rangeFrom.set(Math.min(from, monthNum));
      this.rangeTo.set(Math.max(from, monthNum));
    } else {
      this.rangeFrom.set(monthNum);
      this.rangeTo.set(monthNum);
    }
  }

  runConsultation(): void {
    const catalog = this.targetCatalogMap();
    const keys = [this.draftPrimaryKey(), ...this.draftCompareKeys()];
    const targets = keys
      .map((k) => catalog.get(k))
      .filter((t): t is HistoryTargetOption => Boolean(t));
    if (!targets.length) return;

    const sig = targets.map((t) => t.key).join('|');
    this.querySub?.unsubscribe();
    this.loading.set(true);

    const calls = targets.map((target, idx) =>
      this.api.fetchAnnualHistory(target.scope).pipe(
        map(
          (data): HistorySeriesEntry => ({
            key: target.key,
            label: target.label.replace(/^📍\s*|^🌍\s*/u, ''),
            color: SERIES_ACCENT_COLORS[idx % SERIES_ACCENT_COLORS.length],
            scope: target.scope,
            data
          })
        ),
        catchError(() => of(null))
      )
    );

    this.querySub = forkJoin(calls).subscribe({
      next: (results) => {
        const valid = results.filter((r): r is HistorySeriesEntry => r !== null);
        this.loading.set(false);
        if (!valid.length) {
          this.notifyToast.emit({
            message: this.i18n.l(
              'No se pudo obtener el historial para la selección.',
              'Could not load history for that selection.'
            ),
            isError: true
          });
          return;
        }
        this.loadedSeries.set(valid);
        this.activeTargetsKey.set(sig);
      },
      error: () => {
        this.loading.set(false);
      }
    });
  }

  viewPeriodOnMap(scope: AreaFilterScope | null, year: number, month?: number): void {
    this.closeModal();
    this.applyToMap.emit({
      scope,
      year,
      month: month || this.rangeFrom()
    });
  }

  exportComparisonCsv(): void {
    const series = this.loadedSeries();
    if (!series.length) return;
    const months = this.selectedMonths();
    const compareSet = new Set(this.compareYears());
    const fYear = this.focusYear();
    const mNames = this.i18n.meses().map((n) => n.slice(0, 3));
    const colArea = this.i18n.l('País / Zona', 'Country / Area');
    const colYear = this.i18n.l('Año', 'Year');
    const colRole = this.i18n.l('Comparativa', 'Comparison');
    const colRange = `${this.i18n.l('Rango', 'Range')} (${this.rangeLabel()})`;
    const colYearTotal = this.i18n.l('Total anual', 'Annual total');
    const cols = [colArea, colYear, colRole, colRange, colYearTotal, ...mNames];

    const rows: Array<Record<string, unknown>> = [];
    for (const s of series) {
      for (const y of s.data.porAnio) {
        const role =
          y.anio === fYear
            ? this.i18n.l('Enfoque', 'Focus')
            : compareSet.has(y.anio)
              ? this.i18n.l('Comparado', 'Compared')
              : '—';
        const row: Record<string, unknown> = {
          [colArea]: s.label,
          [colYear]: y.anio,
          [colRole]: role,
          [colRange]: sumMonthsInRange(y.meses, months),
          [colYearTotal]: y.totalFocos
        };
        mNames.forEach((mn, idx) => {
          row[mn] = y.meses[idx] || 0;
        });
        rows.push(row);
      }
    }

    const slug = series
      .map((s) => s.label.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-'))
      .join('-vs-')
      .slice(0, 40);
    const yearsSlug = this.isComparingYears() ? `-${this.activeYears().join('-vs-')}` : '';
    this.csvExport.exportTable(
      'csv',
      rows,
      cols,
      `iris-history-${slug}${yearsSlug}-${this.rangeFrom()}-${this.rangeTo()}`,
      `IRIS Fire History (2000–${this.currentYear})`
    );
    this.notifyToast.emit({
      message: this.i18n.l(
        `CSV histórico exportado (${rows.length} filas).`,
        `Historical CSV exported (${rows.length} rows).`
      )
    });
  }
}

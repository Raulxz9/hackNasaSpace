import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { GeocodeFeature, IdiomaCodigo } from '../../core/models';
import { I18nService, MapboxService } from '../../core/services';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './navbar.component.html'
})
export class NavbarComponent {
  readonly i18n = inject(I18nService);
  private readonly mapbox = inject(MapboxService);
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  readonly live = input.required<boolean>();
  readonly warnActive = input.required<boolean>();
  readonly warnCount = input<number>(0);
  readonly timelineOpen = input.required<boolean>();
  readonly predictionOpen = input.required<boolean>();

  readonly toggleLive = output<void>();
  readonly toggleWarn = output<void>();
  readonly toggleTimeline = output<void>();
  readonly openHistory = output<void>();
  readonly togglePrediction = output<void>();
  readonly languageChanged = output<IdiomaCodigo>();
  readonly notifyToast = output<{ message: string; isError?: boolean }>();
  readonly searchOpenChange = output<boolean>();
  readonly dropdownBottomChange = output<number | null>();

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('langMenuEl') langMenuEl?: ElementRef<HTMLElement>;
  @ViewChild('sugBoxEl') sugBoxEl?: ElementRef<HTMLElement>;

  readonly langMenuOpen = signal(false);
  readonly searchOpen = signal(false);
  readonly query = signal('');
  readonly suggestions = signal<GeocodeFeature[]>([]);

  private suggestTimer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('window:resize')
  onResize(): void {
    this.emitDropdownBottom();
  }

  private emitDropdownBottom(): void {
    setTimeout(() => {
      const bottoms: number[] = [];
      if (this.langMenuOpen() && this.langMenuEl?.nativeElement && !this.langMenuEl.nativeElement.hidden) {
        bottoms.push(this.langMenuEl.nativeElement.getBoundingClientRect().bottom);
      }
      if (this.suggestions().length > 0 && this.sugBoxEl?.nativeElement && !this.sugBoxEl.nativeElement.hidden) {
        bottoms.push(this.sugBoxEl.nativeElement.getBoundingClientRect().bottom);
      }
      this.dropdownBottomChange.emit(bottoms.length ? Math.round(Math.max(...bottoms) + 10) : null);
    }, 0);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    let changed = false;
    if (!target.closest('.langwrap') && this.langMenuOpen()) {
      this.langMenuOpen.set(false);
      changed = true;
    }
    if (!target.closest('#search') && this.suggestions().length > 0) {
      this.suggestions.set([]);
      changed = true;
    }
    if (changed) this.emitDropdownBottom();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.langMenuOpen.set(false);
    this.suggestions.set([]);
    this.emitDropdownBottom();
  }

  toggleLangMenu(event: Event): void {
    event.stopPropagation();
    this.langMenuOpen.update((open) => !open);
    this.emitDropdownBottom();
  }

  selectLanguage(lang: IdiomaCodigo): void {
    this.i18n.setLang(lang);
    this.langMenuOpen.set(false);
    this.mapbox.applyMapLang();
    this.languageChanged.emit(lang);
    this.emitDropdownBottom();
  }

  onSearchButtonClick(): void {
    if (!this.searchOpen()) {
      this.searchOpen.set(true);
      this.searchOpenChange.emit(true);
      setTimeout(() => this.searchInput?.nativeElement.focus(), 30);
      return;
    }
    if (this.query().trim()) {
      void this.executeSearch();
    } else {
      this.searchOpen.set(false);
      this.searchOpenChange.emit(false);
      this.suggestions.set([]);
      this.emitDropdownBottom();
    }
  }

  onSearchInput(value: string): void {
    this.query.set(value);
    if (this.suggestTimer) clearTimeout(this.suggestTimer);
    this.suggestTimer = setTimeout(() => void this.loadSuggestions(), 250);
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      const sug = this.suggestions();
      if (sug.length) {
        this.pickSuggestion(sug[0]);
      } else {
        void this.executeSearch();
      }
    } else if (event.key === 'Escape') {
      this.searchOpen.set(false);
      this.searchOpenChange.emit(false);
      this.suggestions.set([]);
      this.emitDropdownBottom();
    }
  }

  private async loadSuggestions(): Promise<void> {
    const q = this.query().trim();
    if (q.length < 2) {
      this.suggestions.set([]);
      this.emitDropdownBottom();
      return;
    }
    try {
      const results = await this.mapbox.geocode(q, true, 6);
      this.suggestions.set(results);
    } catch {
      this.suggestions.set([]);
    }
    this.emitDropdownBottom();
  }

  pickSuggestion(feature: GeocodeFeature): void {
    this.suggestions.set([]);
    this.emitDropdownBottom();
    this.query.set(feature.place_name);
    this.mapbox.goToFeature(feature);
  }

  formatSubPlace(feature: GeocodeFeature): string {
    return feature.place_name.replace(`${feature.text}, `, '');
  }

  private async executeSearch(): Promise<void> {
    const q = this.query().trim();
    if (!q) return;

    const match = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (match && Math.abs(+match[1]) <= 90 && Math.abs(+match[2]) <= 180) {
      this.mapbox.goToCoordinates(+match[1], +match[2]);
      this.suggestions.set([]);
      this.emitDropdownBottom();
      return;
    }

    try {
      const results = await this.mapbox.geocode(q, false, 1);
      if (!results.length) {
        this.notifyToast.emit({
          message: this.i18n.l(
            `No encontré «${q}». Prueba con otro nombre o con coordenadas.`,
            `I couldn't find “${q}”. Try another name or coordinates.`
          ),
          isError: true
        });
        return;
      }
      this.pickSuggestion(results[0]);
    } catch {
      this.notifyToast.emit({
        message: this.i18n.l('No se pudo buscar. Revisa tu conexión.', 'Search failed. Check your connection.'),
        isError: true
      });
    }
  }
}

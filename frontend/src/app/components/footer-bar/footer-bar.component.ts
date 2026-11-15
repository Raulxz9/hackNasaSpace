import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { I18nService, IncendiosApiService, MapboxService } from '../../core/services';

@Component({
  selector: 'app-footer-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './footer-bar.component.html'
})
export class FooterBarComponent implements OnDestroy {
  readonly i18n = inject(I18nService);
  readonly mapbox = inject(MapboxService);
  readonly api = inject(IncendiosApiService);

  @ViewChild('legalSec') legalSec?: ElementRef<HTMLElement>;
  @ViewChild('btnTop') btnTop?: ElementRef<HTMLButtonElement>;
  @ViewChild('btnTerms') btnTerms?: ElementRef<HTMLButtonElement>;

  readonly legalOpen = signal(false);

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.legalOpen()) {
      this.closeTerms();
    }
  }

  ngOnDestroy(): void {
    document.documentElement.classList.remove('legal-open');
  }

  openTerms(): void {
    this.legalOpen.set(true);
    document.documentElement.classList.add('legal-open');
    setTimeout(() => {
      if (this.legalSec?.nativeElement) {
        this.legalSec.nativeElement.scrollTop = 0;
      }
      this.btnTop?.nativeElement.focus();
    }, 0);
  }

  closeTerms(): void {
    this.legalOpen.set(false);
    document.documentElement.classList.remove('legal-open');
    setTimeout(() => this.btnTerms?.nativeElement.focus(), 0);
  }
}

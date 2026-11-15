import { CommonModule } from '@angular/common';
import { Component, inject, input, output } from '@angular/core';
import { OrigenCalor, SeveridadNivel } from '../../core/models';
import { I18nService } from '../../core/services';

@Component({
  selector: 'app-filters-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './filters-panel.component.html'
})
export class FiltersPanelComponent {
  readonly i18n = inject(I18nService);

  readonly open = input.required<boolean>();
  readonly selectedSevs = input.required<Set<SeveridadNivel>>();
  readonly selectedSources = input.required<Set<OrigenCalor>>();

  readonly toggleOpen = output<void>();
  readonly toggleSeverity = output<{ sev: SeveridadNivel; checked: boolean }>();
  readonly toggleSource = output<{ src: OrigenCalor; checked: boolean }>();

  readonly severities: SeveridadNivel[] = [1, 2, 3, 4, 5];
  readonly sources: OrigenCalor[] = ['veg', 'vol', 'ind', 'sea'];

  readonly sevColors: Record<SeveridadNivel, string> = {
    1: '#FACC15',
    2: '#FB923C',
    3: '#EF4444',
    4: '#B91C1C',
    5: '#7F1D1D'
  };

  onSevChange(sev: SeveridadNivel, event: Event): void {
    const inputEl = event.target as HTMLInputElement;
    if (!inputEl.checked && this.selectedSevs().size <= 1) {
      inputEl.checked = true;
    }
    this.toggleSeverity.emit({ sev, checked: inputEl.checked });
  }

  onSrcChange(src: OrigenCalor, event: Event): void {
    const inputEl = event.target as HTMLInputElement;
    if (!inputEl.checked && this.selectedSources().size <= 1) {
      inputEl.checked = true;
    }
    this.toggleSource.emit({ src, checked: inputEl.checked });
  }
}

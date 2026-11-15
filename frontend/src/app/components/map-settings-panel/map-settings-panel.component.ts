import { CommonModule } from '@angular/common';
import { Component, inject, input, output } from '@angular/core';
import { MapSettings, MapStyleKey } from '../../core/models';
import { I18nService } from '../../core/services';

@Component({
  selector: 'app-map-settings-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './map-settings-panel.component.html'
})
export class MapSettingsPanelComponent {
  readonly i18n = inject(I18nService);

  readonly open = input.required<boolean>();
  readonly settings = input.required<MapSettings>();

  readonly toggleOpen = output<void>();
  readonly settingsChange = output<Partial<MapSettings>>();
  readonly resetView = output<void>();

  onStyleChange(event: Event): void {
    const val = (event.target as HTMLSelectElement).value as MapStyleKey;
    this.settingsChange.emit({ style: val });
  }

  onBoolChange(key: keyof MapSettings, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.settingsChange.emit({ [key]: checked } as Partial<MapSettings>);
  }

  onNumberChange(key: 'size' | 'opacity', event: Event): void {
    const val = +(event.target as HTMLInputElement).value;
    this.settingsChange.emit({ [key]: val } as Partial<MapSettings>);
  }
}

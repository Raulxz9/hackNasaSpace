import { CommonModule } from '@angular/common';
import { Component, inject, input, output } from '@angular/core';
import { AlertHotspot, SeveridadNivel } from '../../core/models';
import { I18nService, MapboxService, ToastNotice } from '../../core/services';

@Component({
  selector: 'app-hotspot-toast',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hotspot-toast.component.html'
})
export class HotspotToastComponent {
  readonly i18n = inject(I18nService);
  private readonly mapbox = inject(MapboxService);

  readonly alerts = input.required<AlertHotspot[]>();
  readonly showAlerts = input.required<boolean>();
  readonly toast = input<ToastNotice | null>(null);
  readonly topOffsetPx = input<number | null>(null);

  readonly dismissAlert = output<string>();
  readonly dismissToast = output<void>();

  readonly sevColors: Record<SeveridadNivel, string> = {
    1: '#FACC15',
    2: '#FB923C',
    3: '#EF4444',
    4: '#B91C1C',
    5: '#7F1D1D'
  };

  onAlertClick(alert: AlertHotspot, event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.x')) {
      this.dismissAlert.emit(alert.id);
      return;
    }
    this.mapbox.flyTo(alert.coordinates, 6, 2200);
    this.dismissAlert.emit(alert.id);
  }

  onToastClick(): void {
    const t = this.toast();
    if (!t?.flyTo) return;
    this.mapbox.flyTo(t.flyTo, 6, 2200);
    this.dismissToast.emit();
  }
}

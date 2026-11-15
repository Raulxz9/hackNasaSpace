import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { HotspotFeature, RiskInputs, RiskOutput, SeveridadNivel } from '../../core/models';
import { I18nService, MapboxService } from '../../core/services';

interface ParamDef {
  key: 'T' | 'H' | 'V' | 'D' | 'S';
  label: string;
  min: number;
  max: number;
  unit: string;
}

@Component({
  selector: 'app-risk-prediction-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './risk-prediction-panel.component.html'
})
export class RiskPredictionPanelComponent {
  readonly i18n = inject(I18nService);
  private readonly mapbox = inject(MapboxService);

  readonly open = input.required<boolean>();
  readonly activeFeatures = input.required<HotspotFeature[]>();

  readonly predictionLayerChange = output<boolean>();

  readonly paramsDef: ParamDef[] = [
    { key: 'T', label: 'Temperatura', min: 5, max: 45, unit: '°C' },
    { key: 'H', label: 'Humedad del aire', min: 5, max: 100, unit: '%' },
    { key: 'V', label: 'Viento', min: 0, max: 80, unit: ' km/h' },
    { key: 'D', label: 'Días sin lluvia', min: 0, max: 40, unit: ' días' },
    { key: 'S', label: 'Vegetación seca', min: 0, max: 100, unit: '%' }
  ];

  readonly values = signal<RiskInputs>({ T: 30, H: 30, V: 20, D: 10, S: 0.6 });
  readonly result = signal<RiskOutput | null>(null);
  readonly nearbyCount = signal<number>(0);

  readonly sevColors: Record<SeveridadNivel, string> = {
    1: '#FACC15',
    2: '#FB923C',
    3: '#EF4444',
    4: '#B91C1C',
    5: '#7F1D1D'
  };

  readonly resultLevel = computed<SeveridadNivel>(() => {
    const score = this.result()?.score ?? 0;
    if (score < 20) return 1;
    if (score < 40) return 2;
    if (score < 60) return 3;
    if (score < 80) return 4;
    return 5;
  });

  readonly maxTermAbs = computed(() => {
    const terms = this.result()?.terms || [];
    return Math.max(0.01, ...terms.map((t) => Math.abs(t.value)));
  });

  displayParamValue(key: ParamDef['key']): number {
    const v = this.values()[key];
    return key === 'S' ? Math.round(v * 100) : v;
  }

  abs(val: number): number {
    return Math.abs(val);
  }

  onParamChange(key: ParamDef['key'], event: Event): void {
    const raw = +(event.target as HTMLInputElement).value;
    this.values.update((cur) => ({
      ...cur,
      [key]: key === 'S' ? raw / 100 : raw
    }));
  }

  calculateHere(): void {
    const center = this.mapbox.getCenter();
    if (!center) return;

    const F = this.countNearbyFires(center.lng, center.lat, 0.6);
    this.nearbyCount.set(F);
    const pr = this.values();
    const output = this.riskEquation({ ...pr, F });
    this.result.set(output);

    const gridFeatures: Array<{ type: 'Feature'; properties: { risk: number }; geometry: { type: 'Point'; coordinates: [number, number] } }> = [];
    for (let gx = -5; gx <= 5; gx++) {
      for (let gy = -5; gy <= 5; gy++) {
        const x = center.lng + gx * 0.3;
        const y = center.lat + gy * 0.3;
        const w = Math.sin(gx * 12.98 + gy * 78.23) * 2;
        const localF = this.countNearbyFires(x, y, 0.4);
        gridFeatures.push({
          type: 'Feature',
          properties: { risk: this.riskEquation({ ...pr, T: pr.T + w, F: localF }).score / 250 },
          geometry: { type: 'Point', coordinates: [x, y] }
        });
      }
    }

    this.mapbox.setRiskData(gridFeatures);
    this.predictionLayerChange.emit(true);
  }

  clearPrediction(): void {
    this.predictionLayerChange.emit(false);
  }

  private countNearbyFires(lng: number, lat: number, radiusDeg: number): number {
    const features = this.activeFeatures();
    let count = 0;
    for (const f of features) {
      const [fLng, fLat] = f.geometry.coordinates;
      if (Math.hypot(fLng - lng, fLat - lat) < radiusDeg) {
        count++;
      }
    }
    return count;
  }

  private riskEquation(i: RiskInputs & { F: number }): RiskOutput {
    const terms: Array<[string, number]> = [
      ['Temperatura', 0.09 * (i.T - 28)],
      ['Aire seco', 0.04 * (35 - i.H)],
      ['Viento', 0.04 * (i.V - 15)],
      ['Días sin lluvia', 0.1 * (i.D - 7)],
      ['Vegetación seca', 1.5 * (i.S - 0.5)],
      ['Focos cercanos', 0.5 * Math.log(1 + i.F)]
    ];
    const z = terms.reduce((sum, [, val]) => sum + val, -0.4);
    return {
      score: Math.round(100 / (1 + Math.exp(-z))),
      terms: terms.map(([label, value]) => ({ label, value }))
    };
  }
}

import { Injectable, inject } from '@angular/core';
import * as XLSX from 'xlsx';
import { HotspotFeature } from '../models';
import { I18nService } from './i18n.service';

@Injectable({ providedIn: 'root' })
export class CsvExportService {
  private readonly i18n = inject(I18nService);

  private downloadBlob(filename: string, mimeType: string, content: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private escapeCsv(value: unknown): string {
    const str = value === undefined || value === null ? '' : String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  private escapeHtml(text: unknown): string {
    return String(text ?? '').replace(/[&<>"]/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] || ch)
    );
  }

  exportFilteredFeaturesCsv(features: HotspotFeature[], filenameBase = 'iris-hotspots-filtrados'): void {
    const headers = [
      'latitude',
      'longitude',
      'datetime_utc',
      'frp_mw',
      'frp_log_norm',
      'scan',
      'confidence',
      'daynight',
      'sensor',
      'country',
      'intensity',
      'heat_source'
    ];
    const sevNames = this.i18n.sevNames();
    const srcNames = this.i18n.srcNames();

    const lines = features.map((f) => {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      return [
        lat,
        lng,
        `${p.date} ${p.time}`,
        p.frp,
        p.frp_log_norm,
        p.scan,
        p.confLabel || p.conf,
        p.daynight,
        p.sensor,
        p.country || p.region,
        sevNames[p.sev] || p.sev,
        srcNames[p.src] || p.src
      ]
        .map((v) => this.escapeCsv(v))
        .join(',');
    });

    const csv = '\ufeff' + [headers.join(','), ...lines].join('\r\n');
    this.downloadBlob(`${filenameBase}.csv`, 'text/csv;charset=utf-8', csv);
  }

  exportTable(
    format: 'csv' | 'json' | 'doc' | 'xlsx',
    rows: Array<Record<string, unknown>>,
    cols: string[],
    filenameBase: string,
    title: string
  ): void {
    if (format === 'json') {
      this.downloadBlob(`${filenameBase}.json`, 'application/json', JSON.stringify(rows, null, 2));
      return;
    }

    if (format === 'csv') {
      const csv =
        '\ufeff' +
        [cols, ...rows.map((row) => cols.map((c) => row[c]))]
          .map((line) => line.map((v) => this.escapeCsv(v)).join(','))
          .join('\r\n');
      this.downloadBlob(`${filenameBase}.csv`, 'text/csv;charset=utf-8', csv);
      return;
    }

    if (format === 'doc') {
      const html = `<html><head><meta charset="utf-8"></head><body><h2>${this.escapeHtml(title)}</h2><table border="1" cellspacing="0" cellpadding="4"><tr>${cols
        .map((c) => `<th>${this.escapeHtml(c)}</th>`)
        .join('')}</tr>${rows
        .map((row) => `<tr>${cols.map((c) => `<td>${this.escapeHtml(row[c])}</td>`).join('')}</tr>`)
        .join('')}</table></body></html>`;
      this.downloadBlob(`${filenameBase}.doc`, 'application/msword', html);
      return;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Incendios');
    XLSX.writeFile(wb, `${filenameBase}.xlsx`);
  }

  exportRegionAnalysisHtml(
    features: HotspotFeature[],
    meta: { name: string; box: [number, number, number, number]; from: string; to: string; d0: number; d1: number },
    filenameBase: string
  ): void {
    const lang = this.i18n.lang();
    const locale = this.i18n.locale();
    const sevNames = this.i18n.sevNames();
    const srcNames = this.i18n.srcNames();
    const sevColors: Record<number, string> = { 1: '#FACC15', 2: '#FB923C', 3: '#EF4444', 4: '#B91C1C', 5: '#7F1D1D' };

    const days = Math.max(1, meta.d1 - meta.d0 + 1);
    const step = days > 120 ? 7 : 1;
    const nb = Math.max(1, Math.ceil(days / step));
    const bins = Array<number>(nb).fill(0);
    const sev = [0, 0, 0, 0, 0, 0];
    const src: Record<string, number> = {};
    const places: Record<string, number> = {};
    const activeDays = new Set<number>();
    let frpSum = 0;

    features.forEach((f) => {
      const p = f.properties;
      const idx = Math.max(0, Math.min(nb - 1, Math.floor((p.day - meta.d0) / step)));
      bins[idx]++;
      sev[p.sev]++;
      src[p.src] = (src[p.src] || 0) + 1;
      const place = p.country || p.region || '—';
      places[place] = (places[place] || 0) + 1;
      frpSum += Number(p.frp) || 0;
      activeDays.add(p.day);
    });

    const mx = Math.max(1, ...bins);
    const pk = bins.indexOf(Math.max(...bins));
    const topSev = [5, 4, 3, 2, 1].find((s) => sev[s] > 0) || 1;
    const W = 860;
    const H = 230;
    const bw = W / nb;
    const n = features.length;
    const dayIso = (d: number) => new Date(d * 864e5).toISOString().slice(0, 10);

    const bars = bins
      .map((v, i) => {
        const h = (v / mx) * (H - 60);
        return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - 30 - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#F97316"><title>${dayIso(meta.d0 + i * step)}: ${v}</title></rect>`;
      })
      .join('');

    const hb = (items: Array<[string, number, string?]>) => {
      const maxVal = Math.max(1, ...items.map((x) => x[1]));
      return items
        .map(
          ([label, val, color]) =>
            `<div class="hb"><span>${this.escapeHtml(label)}</span><div><i style="width:${((val / maxVal) * 100).toFixed(1)}%;background:${color || '#3B82F6'}"></i></div><b>${val.toLocaleString(locale)}</b></div>`
        )
        .join('');
    };

    const strong = features
      .slice()
      .sort((a, b) => b.properties.sev - a.properties.sev || b.properties.frp - a.properties.frp)
      .slice(0, 10);

    const kpis: Array<[string, string]> = [
      [n.toLocaleString(locale), this.i18n.l('focos detectados', 'hotspots detected')],
      [`${activeDays.size} / ${days}`, this.i18n.l('días con actividad', 'days with activity')],
      [
        `${dayIso(meta.d0 + pk * step)} (${mx})`,
        step > 1 ? this.i18n.l('semana más activa', 'busiest week (start)') : this.i18n.l('día más activo', 'busiest day')
      ],
      [sevNames[topSev] || '', this.i18n.l('intensidad máxima', 'peak intensity')],
      [`${(frpSum / n).toFixed(1)} MW`, this.i18n.l('FRP promedio', 'average FRP')],
      [`${Math.round(frpSum).toLocaleString(locale)} MW`, this.i18n.l('FRP acumulado', 'total FRP')]
    ];

    const cols = this.i18n.cols();
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IRIS · ${this.escapeHtml(meta.name)}</title><style>
body{margin:0;background:#F3F5F9;color:#14213D;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}main{max-width:940px;margin:0 auto;padding:32px 20px 48px}
h1{margin:0 0 4px;font-size:28px}h2{margin:30px 0 10px;font-size:18px}.sub{color:#5A6785;margin:2px 0}.real{display:inline-block;margin-top:10px;padding:4px 10px;border-radius:99px;background:#E0F2FE;color:#0369A1;font-size:12.5px}
.kp{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:18px}.kp div{background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(20,33,61,.1)}.kp b{display:block;font-size:20px}.kp span{color:#5A6785;font-size:12.5px}
.card{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(20,33,61,.1)}svg{width:100%;height:auto}.hb{display:grid;grid-template-columns:190px 1fr 56px;gap:10px;align-items:center;margin:6px 0;font-size:13.5px}.hb div{height:12px;background:#E6EAF2;border-radius:6px;overflow:hidden}.hb i{display:block;height:100%}.hb b{text-align:right}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #E6EAF2}th{color:#5A6785}button{margin-top:16px;padding:8px 14px;border:0;border-radius:8px;background:#14213D;color:#fff;font:inherit;cursor:pointer}
@media(max-width:640px){.kp{grid-template-columns:1fr 1fr}.hb{grid-template-columns:110px 1fr 46px}}@media print{body{background:#fff}button{display:none}}</style></head><body><main>
<h1>IRIS · ${this.i18n.l('Análisis de actividad de incendios', 'Fire activity analysis')}</h1>
<p class="sub"><b>📍 ${this.escapeHtml(meta.name)}</b> (${meta.box[1].toFixed(2)}°, ${meta.box[0].toFixed(2)}° → ${meta.box[3].toFixed(2)}°, ${meta.box[2].toFixed(2)}°)</p>
<p class="sub">${this.i18n.l('Periodo', 'Period')}: ${meta.from} → ${meta.to} · ${this.i18n.l('Generado', 'Generated')}: ${new Date().toLocaleString(locale)}</p><span class="real">${this.i18n.l('Datos reales armonizados MODIS + VIIRS · NASA FIRMS', 'Real harmonized MODIS + VIIRS data · NASA FIRMS')}</span><br><button onclick="print()">🖨 ${this.i18n.l('Imprimir / guardar como PDF', 'Print / save as PDF')}</button>
<div class="kp">${kpis.map(([v, l]) => `<div><b>${this.escapeHtml(v)}</b><span>${this.escapeHtml(l)}</span></div>`).join('')}</div>
<h2>${step > 1 ? this.i18n.l('Focos por semana', 'Hotspots per week') : this.i18n.l('Focos por día', 'Hotspots per day')}</h2><div class="card"><svg viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${H - 30}" y2="${H - 30}" stroke="#C9D1E0"/>${bars}
<text x="0" y="${H - 10}" font-size="12" fill="#5A6785">${dayIso(meta.d0)}</text><text x="${W}" y="${H - 10}" font-size="12" fill="#5A6785" text-anchor="end">${dayIso(meta.d1)}</text><text x="0" y="12" font-size="12" fill="#5A6785">max ${mx}</text></svg></div>
<h2>${this.i18n.l('Intensidad', 'Intensity')}</h2><div class="card">${hb([5, 4, 3, 2, 1].map((q): [string, number, string] => [sevNames[q], sev[q], sevColors[q]]))}</div>
<h2>${this.i18n.l('Origen del calor', 'Heat source')}</h2><div class="card">${hb(Object.keys(src).map((k): [string, number] => [srcNames[k as 'veg'] || k, src[k]]).sort((a, b) => b[1] - a[1]))}</div>
<h2>${this.i18n.l('Lugares con más focos', 'Places with most hotspots')}</h2><div class="card">${hb(Object.entries(places).sort((a, b) => b[1] - a[1]).slice(0, 8))}</div>
<h2>${this.i18n.l('Los 10 focos más intensos', 'Top 10 strongest hotspots')}</h2><div class="card" style="overflow:auto"><table><tr>${[cols[0], cols[1], cols[2], this.i18n.l('Coordenadas', 'Coordinates'), cols[5], 'FRP', 'Sensor'].map((c) => `<th>${this.escapeHtml(c)}</th>`).join('')}</tr>
${strong
  .map((x) => {
    const p = x.properties;
    const c = x.geometry.coordinates;
    return `<tr><td>${this.escapeHtml(p.date)}</td><td>${this.escapeHtml(p.time)}</td><td>${this.escapeHtml(p.country || p.region)}</td><td>${c[1].toFixed(3)}, ${c[0].toFixed(3)}</td><td>${this.escapeHtml(sevNames[p.sev])}</td><td>${p.frp} MW</td><td>${this.escapeHtml(p.sensor)}</td></tr>`;
  })
  .join('')}</table></div>
<p class="sub" style="margin-top:24px">${this.i18n.l('IRIS · Mapas © Mapbox · © OpenStreetMap · NASA FIRMS. Este reporte es informativo y no sustituye a las autoridades de protección civil.', 'IRIS · Maps © Mapbox · © OpenStreetMap · NASA FIRMS. This report is informational and does not replace civil protection authorities.')}</p></main></body></html>`;

    this.downloadBlob(`${filenameBase}.html`, 'text/html;charset=utf-8', html);
  }
}

export const THERMAL_RAMP_STOPS: ReadonlyArray<[number, number, number, number]> = [
  [0.0, 56, 189, 248],
  [0.28, 45, 212, 191],
  [0.52, 250, 204, 21],
  [0.76, 251, 146, 60],
  [1.0, 239, 68, 68]
];

export const THERMAL_LEGEND_STOPS: ReadonlyArray<string> = [
  'rgb(56, 189, 248)',
  'rgb(45, 212, 191)',
  'rgb(250, 204, 21)',
  'rgb(251, 146, 60)',
  'rgb(239, 68, 68)'
];

export const SERIES_ACCENT_COLORS: ReadonlyArray<string> = [
  '#38BDF8',
  '#FB923C',
  '#A78BFA',
  '#2DD4BF'
];

export function computeThermalLogNorm(value: number, maxVal: number): number {
  if (value <= 0 || maxVal <= 0) return 0;
  return Math.max(0.14, Math.min(1, Math.log1p(value) / Math.log1p(maxVal)));
}

export function computeThermalRampColor(norm: number): string {
  if (norm <= 0 || !Number.isFinite(norm)) return 'rgba(148, 160, 186, 0.28)';
  const t = Math.max(0, Math.min(1, norm));
  for (let i = 1; i < THERMAL_RAMP_STOPS.length; i++) {
    const [t1, r1, g1, b1] = THERMAL_RAMP_STOPS[i];
    if (t <= t1 || i === THERMAL_RAMP_STOPS.length - 1) {
      const [t0, r0, g0, b0] = THERMAL_RAMP_STOPS[i - 1];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      const r = Math.round(r0 + (r1 - r0) * f);
      const g = Math.round(g0 + (g1 - g0) * f);
      const b = Math.round(b0 + (b1 - b0) * f);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return 'rgb(239, 68, 68)';
}

export function buildMonthRangeList(fromMonth: number, toMonth: number): number[] {
  const from = Math.max(1, Math.min(12, Math.round(fromMonth)));
  const to = Math.max(1, Math.min(12, Math.round(toMonth)));
  const months: number[] = [];
  if (from <= to) {
    for (let m = from; m <= to; m++) months.push(m);
  } else {
    for (let m = from; m <= 12; m++) months.push(m);
    for (let m = 1; m <= to; m++) months.push(m);
  }
  return months;
}

export function sumMonthsInRange(monthlyTotals: ReadonlyArray<number>, months: ReadonlyArray<number>): number {
  let sum = 0;
  for (const m of months) {
    sum += Number(monthlyTotals[m - 1] || 0);
  }
  return sum;
}

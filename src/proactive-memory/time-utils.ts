export function isLateNight(hour: number): boolean {
  return hour >= 23 || hour < 5;
}

export function isWeekend(): boolean {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

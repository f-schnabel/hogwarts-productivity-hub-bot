// 📊 Progress Bar Generator
export function createProgressBar(current: number, max: number, length: number, fillChar = "▓", emptyChar = "░") {
  const percentage = Math.min(100, Math.max(0, (current / max) * 100));
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;

  const bar = fillChar.repeat(filled) + emptyChar.repeat(empty);
  return {
    bar: `${bar} ${percentage.toFixed(1)}%`,
    percentage: percentage.toFixed(1),
  };
}

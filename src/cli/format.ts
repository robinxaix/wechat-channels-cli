/** 终端表格渲染（等宽对齐，中文按两格宽计算）。 */

/** 计算显示宽度：CJK 及全角字符算 2。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => displayWidth(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? '', widths[i] ?? 0)).join('  ').trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

/** 截断过长文本，避免撑爆终端。 */
export function truncate(text: string, max: number): string {
  const s = String(text ?? '');
  return displayWidth(s) <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

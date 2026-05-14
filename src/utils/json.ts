export function stripJsonc(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx === -1) return line;
      const before = line.slice(0, idx);
      const dq = (before.match(/"/g) ?? []).length;
      const sq = (before.match(/'/g) ?? []).length;
      if (dq % 2 === 0 && sq % 2 === 0) return before;
      return line;
    })
    .join("\n");
}

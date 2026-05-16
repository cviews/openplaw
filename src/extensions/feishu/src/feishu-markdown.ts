const FEISHU_CARD_TABLE_LIMIT = 4;

export function optimizeMarkdownForFeishu(text: string): string {
  try {
    let r = protectCodeBlocksAndProcess(text);
    r = stripInvalidImageKeys(r);
    r = compressExcessBlankLines(r);
    return r;
  } catch {
    return text;
  }
}

function protectCodeBlocksAndProcess(text: string): string {
  const MARK = "___CB_";
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, "##### $1");
    r = r.replace(/^# (.+)$/gm, "#### $1");
  }

  r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
  r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");

  codeBlocks.forEach((block, i) => {
    const replacement = `\n<br>\n${block}\n<br>\n`;
    r = r.replace(`${MARK}${i}___`, replacement);
  });

  return r;
}

function compressExcessBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function stripInvalidImageKeys(text: string): string {
  if (!text.includes("![")) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith("img_")) return fullMatch;
    return "";
  });
}

type MarkdownTableMatch = {
  index: number;
  length: number;
  raw: string;
};

function findMarkdownTablesOutsideCodeBlocks(text: string): MarkdownTableMatch[] {
  const codeBlockRanges: Array<{ start: number; end: number }> = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let cbMatch = codeBlockRegex.exec(text);
  while (cbMatch != null) {
    codeBlockRanges.push({
      start: cbMatch.index,
      end: cbMatch.index + cbMatch[0].length,
    });
    cbMatch = codeBlockRegex.exec(text);
  }
  const isInsideCodeBlock = (idx: number): boolean =>
    codeBlockRanges.some((range) => idx >= range.start && idx < range.end);

  const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g;
  const matches: MarkdownTableMatch[] = [];
  let tableMatch = tableRegex.exec(text);
  while (tableMatch != null) {
    if (!isInsideCodeBlock(tableMatch.index)) {
      matches.push({
        index: tableMatch.index,
        length: tableMatch[0].length,
        raw: tableMatch[0],
      });
    }
    tableMatch = tableRegex.exec(text);
  }
  return matches;
}

export function sanitizeTextForCard(
  text: string,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string {
  const matches = findMarkdownTablesOutsideCodeBlocks(text);
  if (matches.length <= tableLimit) return text;

  let result = text;
  for (let i = matches.length - 1; i >= tableLimit; i--) {
    const { index, length, raw } = matches[i]!;
    const replacement = "```\n" + raw + "\n```";
    result = result.slice(0, index) + replacement + result.slice(index + length);
  }
  return result;
}
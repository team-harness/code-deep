export const GRAPH_ADAPTER_SCHEMA_VERSION = 1 as const;

export interface GraphReader {
  callText(name: string, args: Record<string, unknown>): Promise<string>;
}

export type GraphConfidence = 'high' | 'medium' | 'low';

export interface GraphSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface GraphSymbolCatalog {
  schemaVersion: typeof GRAPH_ADAPTER_SCHEMA_VERSION;
  file: string;
  symbols: GraphSymbol[];
  confidence: GraphConfidence;
  warnings: string[];
  rawText: string;
}

export interface GraphAffectedSymbol {
  file: string;
  name: string;
  line: number;
}

export interface GraphImpact {
  schemaVersion: typeof GRAPH_ADAPTER_SCHEMA_VERSION;
  symbol: string;
  file: string;
  affectedCount: number;
  affectedSymbols: GraphAffectedSymbol[];
  testFiles: string[];
  confidence: GraphConfidence;
  warnings: string[];
  rawText: string;
}

export interface GraphContext {
  schemaVersion: typeof GRAPH_ADAPTER_SCHEMA_VERSION;
  text: string;
  confidence: GraphConfidence;
  warnings: string[];
}

export class CodeGraphAdapter {
  constructor(private readonly reader: GraphReader) {}

  async getSymbols(file: string, projectPath: string): Promise<GraphSymbolCatalog> {
    const rawText = await this.reader.callText('codegraph_node', {
      file,
      symbolsOnly: true,
      projectPath,
    });
    return parseSymbolCatalog(file, rawText);
  }

  async getImpact(
    symbol: string,
    file: string,
    projectPath: string,
    depth = 2,
  ): Promise<GraphImpact> {
    const rawText = await this.reader.callText('codegraph_impact', {
      symbol,
      file,
      depth,
      projectPath,
    });
    return parseImpact(symbol, file, rawText);
  }

  async explore(query: string, projectPath: string, maxFiles: number): Promise<GraphContext> {
    const text = await this.reader.callText('codegraph_explore', {
      query,
      maxFiles,
      projectPath,
    });
    return {
      schemaVersion: GRAPH_ADAPTER_SCHEMA_VERSION,
      text,
      confidence: text.trim() ? 'high' : 'medium',
      warnings: [],
    };
  }
}

export function parseSymbolCatalog(file: string, rawText: string): GraphSymbolCatalog {
  const symbols: GraphSymbol[] = [];
  const pattern = /^- `([^`]+)` \(([^)]+)\).* — :(\d+)\r?$/gm;
  for (const match of rawText.matchAll(pattern)) {
    symbols.push({
      name: match[1]!,
      kind: match[2]!,
      line: Number(match[3]),
    });
  }
  symbols.sort((left, right) => left.line - right.line);

  const warnings: string[] = [];
  const declaredCount = parseDeclaredSymbolCount(rawText);
  if (declaredCount !== null && declaredCount !== symbols.length) {
    warnings.push('symbol-count-mismatch');
  }
  if (rawText.trim() && symbols.length === 0 && declaredCount !== 0) {
    warnings.push('unrecognized-symbol-format');
  }

  return {
    schemaVersion: GRAPH_ADAPTER_SCHEMA_VERSION,
    file,
    symbols,
    confidence: warnings.length ? 'low' : rawText.trim() ? 'high' : 'medium',
    warnings,
    rawText,
  };
}

export function parseImpact(symbol: string, file: string, rawText: string): GraphImpact {
  const header = rawText.match(/\baffects\s+([\d,]+)\s+symbols?\b/i);
  const headerCount = header?.[1]
    ? Number(header[1].replaceAll(',', ''))
    : null;
  const affectedSymbols = parseAffectedSymbols(rawText);
  const bulletCount = rawText.match(/^- /gm)?.length ?? 0;
  const affectedCount = headerCount ?? (affectedSymbols.length || bulletCount);
  const warnings: string[] = [];

  if (headerCount !== null && affectedSymbols.length > 0 && headerCount !== affectedSymbols.length) {
    warnings.push('impact-count-mismatch');
  }
  if (rawText.trim() && headerCount === null && affectedSymbols.length === 0 && bulletCount === 0) {
    warnings.push('unrecognized-impact-format');
  }

  let confidence: GraphConfidence = 'low';
  if (
    headerCount !== null
    && headerCount === affectedSymbols.length
    && warnings.length === 0
  ) {
    confidence = 'high';
  } else if (headerCount !== null || affectedSymbols.length > 0) {
    confidence = 'medium';
  }

  return {
    schemaVersion: GRAPH_ADAPTER_SCHEMA_VERSION,
    symbol,
    file,
    affectedCount,
    affectedSymbols,
    testFiles: [...new Set(
      affectedSymbols
        .map((item) => item.file)
        .filter((path) => isTestPath(path)),
    )].sort(),
    confidence,
    warnings,
    rawText,
  };
}

function parseAffectedSymbols(rawText: string): GraphAffectedSymbol[] {
  const affected: GraphAffectedSymbol[] = [];
  let currentFile: string | null = null;
  for (const line of rawText.split(/\r?\n/)) {
    const section = line.match(/^\*\*(.+):\*\*$/);
    if (section?.[1]) {
      currentFile = section[1];
      continue;
    }
    if (!currentFile || !line.trim()) continue;
    for (const entry of line.split(',')) {
      const match = entry.trim().match(/^(.*):(\d+)$/);
      if (!match?.[1] || !match[2]) continue;
      affected.push({
        file: currentFile,
        name: match[1],
        line: Number(match[2]),
      });
    }
  }
  return affected;
}

function parseDeclaredSymbolCount(text: string): number | null {
  const match = text.match(/—\s+([\d,]+)\s+symbols?\b/i);
  return match?.[1] ? Number(match[1].replaceAll(',', '')) : null;
}

export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path);
}

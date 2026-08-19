export type ExploreDetailLevel = 'minimal' | 'standard';

export interface ExploreProjectionMetadata {
  schemaVersion: 1;
  detailLevel: ExploreDetailLevel;
  originalCharacters: number;
  returnedCharacters: number;
  charactersOmitted: number;
  sourceFilesFound: number;
  sourceFilesReturned: number;
  sourceFilesOmitted: number;
  returnedSourceFiles: string[];
  omittedSourceFiles: string[];
  omittedSourceFilesUnlisted: number;
  truncated: boolean;
}

export interface ExploreProjection {
  text: string;
  metadata: ExploreProjectionMetadata;
}

const RESPONSE_LIMITS = {
  minimal: {
    maxCharacters: 8_000,
    maxStructuralCharacters: 2_500,
    maxSourceFiles: 1,
    maxSourceFileCharacters: 4_500,
  },
  standard: {
    maxCharacters: 20_000,
    maxStructuralCharacters: 4_000,
    maxSourceFiles: 3,
    maxSourceFileCharacters: 4_500,
  },
} as const;

const MAX_LISTED_OMITTED_SOURCE_FILES = 3;

export function projectExploreText(
  text: string,
  detailLevel: ExploreDetailLevel,
): ExploreProjection {
  const limits = RESPONSE_LIMITS[detailLevel];
  const sections = splitExploreSections(text);
  const structuralLimit = sections.sourceBlocks.length
    ? limits.maxStructuralCharacters
    : limits.maxCharacters - 1_000;
  const structural = projectMarkdownSection(sections.structural, structuralLimit);
  const returnedSourceBlocks = sections.sourceBlocks
    .slice(0, limits.maxSourceFiles)
    .map((block) => ({
      path: block.path,
      ...projectMarkdownSection(block.text, limits.maxSourceFileCharacters),
    }));
  const omittedSourceBlocks = sections.sourceBlocks.slice(limits.maxSourceFiles);
  const sourceFilesFound = sections.sourceBlocks.length;
  const sourceFilesReturned = returnedSourceBlocks.length;
  const sourceFilesOmitted = Math.max(0, sourceFilesFound - sourceFilesReturned);
  const returnedSourceFiles = returnedSourceBlocks.flatMap((block) => block.path ? [block.path] : []);
  const omittedSourceFiles = omittedSourceBlocks
    .flatMap((block) => block.path ? [block.path] : [])
    .slice(0, MAX_LISTED_OMITTED_SOURCE_FILES);
  const omittedSourceFilesUnlisted = Math.max(0, sourceFilesOmitted - omittedSourceFiles.length);
  const retainedCharacters = structural.retainedCharacters
    + returnedSourceBlocks.reduce((total, block) => total + block.retainedCharacters, 0);
  const charactersOmitted = Math.max(0, text.length - retainedCharacters);
  const truncated = charactersOmitted > 0 || sourceFilesOmitted > 0;
  const parts = [structural.text].filter(Boolean);
  if (returnedSourceBlocks.length) {
    parts.push('**Source Code (projected)**', ...returnedSourceBlocks.map((block) => block.text));
  }
  if (truncated) {
    const guidance = detailLevel === 'minimal'
      ? 'Request detailLevel standard for bounded source, or run a targeted explore query.'
      : 'Run a targeted explore query for omitted files or complete symbol bodies.';
    parts.push([
      '## Progressive output',
      '',
      `- Retained ${retainedCharacters} of ${text.length} original characters; ${charactersOmitted} omitted.`,
      `- Source files returned: ${sourceFilesReturned}/${sourceFilesFound}.`,
      ...(omittedSourceFiles.length
        ? [`- Next source targets: ${omittedSourceFiles.join(', ')}.`]
        : []),
      `- ${guidance}`,
    ].join('\n'));
  }
  let projectedText = parts.join('\n\n');
  if (projectedText.length > limits.maxCharacters) {
    projectedText = projectMarkdownSection(projectedText, limits.maxCharacters).text;
  }
  return {
    text: projectedText,
    metadata: {
      schemaVersion: 1,
      detailLevel,
      originalCharacters: text.length,
      returnedCharacters: projectedText.length,
      charactersOmitted,
      sourceFilesFound,
      sourceFilesReturned,
      sourceFilesOmitted,
      returnedSourceFiles,
      omittedSourceFiles,
      omittedSourceFilesUnlisted,
      truncated,
    },
  };
}

function splitExploreSections(text: string): {
  structural: string;
  sourceBlocks: Array<{ path: string | null; text: string }>;
} {
  const marker = /(?:^|\r?\n)\*\*Source Code\*\*(?:\r?\n|$)/m.exec(text);
  if (!marker || marker.index === undefined) {
    return { structural: text, sourceBlocks: [] };
  }
  const markerStart = marker.index + (marker[0].startsWith('\n') || marker[0].startsWith('\r') ? 1 : 0);
  const structural = text.slice(0, markerStart).trimEnd();
  const sourceText = text.slice(marker.index + marker[0].length).trim();
  const headers = [...sourceText.matchAll(/^\*\*`([^`\r\n]+)`\*\*.*$/gm)];
  if (!headers.length) {
    return {
      structural,
      sourceBlocks: sourceText ? [{ path: null, text: sourceText }] : [],
    };
  }
  const sourceBlocks = headers.map((header, index) => {
    const start = header.index!;
    const end = headers[index + 1]?.index ?? sourceText.length;
    return {
      path: header[1] ?? null,
      text: sourceText.slice(start, end).trim(),
    };
  });
  return { structural, sourceBlocks };
}

function projectMarkdownSection(text: string, maxCharacters: number): {
  text: string;
  retainedCharacters: number;
} {
  if (maxCharacters <= 0) return { text: '', retainedCharacters: 0 };
  if (text.length <= maxCharacters) return { text, retainedCharacters: text.length };
  const lineBreak = text.lastIndexOf('\n', maxCharacters);
  const retainedCharacters = lineBreak >= Math.floor(maxCharacters / 2)
    ? lineBreak
    : maxCharacters;
  let projected = text.slice(0, retainedCharacters).trimEnd();
  const backtickFences = projected.match(/^```/gm)?.length ?? 0;
  const tildeFences = projected.match(/^~~~/gm)?.length ?? 0;
  if (backtickFences % 2 === 1) projected += '\n```';
  if (tildeFences % 2 === 1) projected += '\n~~~';
  return {
    text: `${projected}\n... (section truncated; use a targeted explore query for more.)`,
    retainedCharacters,
  };
}

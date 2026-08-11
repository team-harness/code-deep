import { CodeGraphBridge } from './codegraph-bridge.js';
import {
  ReviewAnalyzer,
  type ReviewReport,
  type ReviewRequest,
} from './review.js';

export interface CodeIntelClientOptions {
  projectPath: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ExploreOptions {
  maxFiles?: number;
}

export type CodeIntelReviewOptions = Omit<ReviewRequest, 'projectPath'>;

/** Public library facade for exploration and review over one persistent bridge. */
export class CodeIntelClient {
  private readonly bridge: CodeGraphBridge;
  private readonly analyzer: ReviewAnalyzer;

  constructor(private readonly options: CodeIntelClientOptions) {
    this.bridge = new CodeGraphBridge(options);
    this.analyzer = new ReviewAnalyzer(this.bridge);
  }

  async explore(query: string, options: ExploreOptions = {}): Promise<string> {
    return this.bridge.callText('codegraph_explore', {
      query,
      maxFiles: options.maxFiles ?? 12,
      projectPath: this.options.projectPath,
    });
  }

  async review(options: CodeIntelReviewOptions = {}): Promise<ReviewReport> {
    return this.analyzer.analyze({
      ...options,
      projectPath: this.options.projectPath,
    });
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }
}

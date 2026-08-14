import { CodeGraphBridge } from './codegraph-bridge.js';
import {
  ReviewAnalyzer,
  validateReviewRequest,
  type ReviewReport,
  type ReviewRequest,
} from './review.js';

export interface CodeDeepClientOptions {
  projectPath: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  autoInit?: boolean;
}

export interface ExploreOptions {
  maxFiles?: number;
}

export type CodeDeepReviewOptions = Omit<ReviewRequest, 'projectPath'>;

/** Public library facade for exploration and review over one persistent bridge. */
export class CodeDeepClient {
  private readonly bridge: CodeGraphBridge;
  private readonly analyzer: ReviewAnalyzer;

  constructor(private readonly options: CodeDeepClientOptions) {
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

  async review(options: CodeDeepReviewOptions = {}): Promise<ReviewReport> {
    const request = {
      ...options,
      projectPath: this.options.projectPath,
    };
    validateReviewRequest(request);
    await this.bridge.ensureProjectIndex(this.options.projectPath);
    return this.analyzer.analyze(request);
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }
}

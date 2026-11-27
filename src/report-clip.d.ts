export type ClipMiddleOptions = {
  threadId?: string | null;
};

export type CompactFileLinksOptions = {
  rootPath?: string | null;
  rootPaths?: readonly (string | null | undefined)[];
};

export declare function clipMiddle(value: string, max: number, options?: ClipMiddleOptions): string;
export declare function compactFileLinks(value: string, options?: CompactFileLinksOptions): string;
export declare function selectFinalMessage(segments: readonly string[]): string;

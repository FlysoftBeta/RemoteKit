export interface DocumentPage {
  id: string;
  ordinal: number;
  width: number;
  height: number;
  document: string;
  dependencies: string[];
}

export interface DocumentInfo {
  documentId: string;
  pages: DocumentPage[];
  shared: string[];
}

export interface DocumentResource {
  mime: string;
  data: Blob;
}

export interface DocumentOpenOptions {
  onStatus?: (status: 'converting' | 'ready') => void;
}

export interface DocumentSource {
  /** Resolves when the rendition is ready; rejects with RemoteKitError on failure. */
  open(signal: AbortSignal, options?: DocumentOpenOptions): Promise<DocumentInfo>;
  resource(contentId: string, signal: AbortSignal): Promise<DocumentResource>;
}

/** Zero-based page index; offset is a fraction of that page's height, from 0 to 1. */
export interface DocumentProgress {
  page: number;
  offset: number;
}

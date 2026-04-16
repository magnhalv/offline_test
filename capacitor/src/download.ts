import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { ServerConfig } from './config';
import { CapacitorDownloader } from '@capgo/capacitor-downloader';

export enum DownloadStatus {
  Idle = 'idle',
  Downloading = 'downloading',
  Completed = 'completed',
  Failed = 'failed',
}

export interface DownloadProgress {
  status: DownloadStatus;
  /** 0.0 – 1.0; only meaningful while Downloading */
  progress: number;
  errorMessage?: string;
  localFileName?: string;
}

export type ProgressCallback = (p: DownloadProgress) => void;

const DOWNLOAD_ID = 'tpk-download';

export class DownloadService {
  private _webBuffer: ArrayBuffer | null = null;

  /** Returns true if the file has been downloaded previously. */
  async fileExistsLocally(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
      try {
        await Filesystem.stat({
          path: ServerConfig.localFileName,
          directory: Directory.Documents,
        });
        return true;
      } catch {
        return false;
      }

    }
    else {
      return Promise.resolve(this._webBuffer != null);
    }
  }

  /** Removes the locally cached file. */
  async deleteCachedFile(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        await Filesystem.deleteFile({
          path: ServerConfig.localFileName,
          directory: Directory.Documents,
        });
      } catch {
        // File did not exist – that's fine.
      }
    }
    else {
      this._webBuffer = null;
    }
  }

  async downloadFile(onProgress: ProgressCallback): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      return this.downloadFileNative(onProgress);
    }
    else {
      return this.downloadFileWeb(onProgress);
    }
  }
  /**
   * Downloads the configured file using HTTP Basic Auth via @capgo/capacitor-downloader.
   * The download runs natively and continues in the background.
   * Calls onProgress with streaming progress updates.
   */
  async downloadFileNative(onProgress: ProgressCallback): Promise<void> {
    onProgress({ status: DownloadStatus.Downloading, progress: 0 });

    const credentials = btoa(`${ServerConfig.username}:${ServerConfig.password}`);

    const fileInfo = await Filesystem.getUri({
      directory: Directory.Documents,
      path: ServerConfig.localFileName,
    });

    const listeners: Array<{ remove: () => Promise<void> }> = [];
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      listeners.forEach((l) => l.remove());
    };

    const progressListener = await CapacitorDownloader.addListener('downloadProgress', (data) => {
      if (data.id === DOWNLOAD_ID) {
        onProgress({
          status: DownloadStatus.Downloading,
          progress: data.progress / 100,
        });
      }
    });
    listeners.push(progressListener);

    const completedListener = await CapacitorDownloader.addListener('downloadCompleted', (result) => {
      if (result.id === DOWNLOAD_ID) {
        onProgress({
          status: DownloadStatus.Completed,
          progress: 1,
          localFileName: ServerConfig.localFileName,
        });
        cleanup();
      }
    });
    listeners.push(completedListener);

    const failedListener = await CapacitorDownloader.addListener('downloadFailed', (error) => {
      if (error.id === DOWNLOAD_ID) {
        onProgress({
          status: DownloadStatus.Failed,
          progress: 0,
          errorMessage: error.error,
        });
        cleanup();
      }
    });
    listeners.push(failedListener);

    try {
      await CapacitorDownloader.download({
        id: DOWNLOAD_ID,
        url: ServerConfig.fileUrl,
        destination: fileInfo.uri,
        headers: {
          Authorization: `Basic ${credentials}`,
        },
      });
    } catch (error: any) {
      onProgress({
        status: DownloadStatus.Failed,
        progress: 0,
        errorMessage: error.message ?? String(error),
      });
      cleanup();
    }
  }

  async downloadFileWeb(onProgress: ProgressCallback): Promise<void> {
    onProgress({ status: DownloadStatus.Downloading, progress: 0 });

    const credentials = btoa(`${ServerConfig.username}:${ServerConfig.password}`);

    try {
      const response = await fetch(ServerConfig.fileUrl, {
        headers: { Authorization: `Basic ${credentials}` },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = Number(response.headers.get('Content-Length') ?? '0');
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let bytesReceived = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytesReceived += value.length;
        if (contentLength > 0) {
          onProgress({
            status: DownloadStatus.Downloading,
            progress: bytesReceived / contentLength,
          });
        }
      }

      // Combine chunks into a single ArrayBuffer and keep in memory
      const buffer = new Uint8Array(bytesReceived);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      this._webBuffer = buffer.buffer;

      onProgress({
        status: DownloadStatus.Completed,
        progress: 1,
        localFileName: ServerConfig.localFileName,
      });
    } catch (error: any) {
      onProgress({
        status: DownloadStatus.Failed,
        progress: 0,
        errorMessage: error.message ?? String(error),
      });
    }
  }

  async getDownloadedTpkFile(): Promise<ArrayBuffer> {
    if (Capacitor.isNativePlatform()) {
      const result = await Filesystem.readFile({
        path: ServerConfig.localFileName,
        directory: Directory.Documents,
      });
      if (result.data instanceof Blob) {
        return result.data.arrayBuffer();
      }
      const binaryString = atob(result.data as string);
      const buffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        buffer[i] = binaryString.charCodeAt(i);
      }
      return buffer.buffer;
    } else {
      if (!this._webBuffer) {
        throw new Error('No file in memory — download it first.');
      }
      return this._webBuffer;
    }
  }
}

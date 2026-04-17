import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
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

const LOCAL_RELATIVE_PATH = `downloads/${ServerConfig.localFileName}`;


export async function testFilesystem(): Promise<void> {
  // const content = 'hello from testFilesystem';
  // const path = 'test_write.txt';
  // console.log('[testFilesystem] Writing:', JSON.stringify(content), 'to path:', path);
  // console.log(JSON.stringify(await Filesystem.getUri({ path, directory: Directory.Data })));
  // console.log(JSON.stringify(await Filesystem.getUri({ path, directory: Directory.Documents })));
  // {
  //   const path = 'test_write_data.txt';
  //   await Filesystem.writeFile({ path, data: content, encoding: Encoding.UTF8, directory: Directory.External });
  //   let result = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 } as any);
  //   console.log(`[testFilesystem]: ${path}`, JSON.stringify(result.data));
  // }
  //
  // {
  //   const path = 'test_write_documents.txt';
  //   await Filesystem.writeFile({ path, data: content, encoding: Encoding.UTF8, recursive: true, directory: Directory.Documents });
  //   let result = await Filesystem.readFile({ path, directory: Directory.Documents, encoding: Encoding.UTF8 } as any);
  //   console.log(`[testFilesystem]: ${path}`, JSON.stringify(result.data));
  // }
  //
  // {
  //   let result = await Filesystem.readFile({ path: 'test1.txt', directory: Directory.External, encoding: Encoding.UTF8 } as any);
  //   console.log('[testFilesystem]2 Read back:', JSON.stringify(result.data));
  // }
}

export class DownloadService {
  private _webBuffer: ArrayBuffer | null = null;

  /** Returns a URL that can be streamed directly — no file loaded into memory. */
  async getTpkUrl(): Promise<string> {
    if (Capacitor.isNativePlatform()) {
      const { uri } = await Filesystem.getUri({ path: LOCAL_RELATIVE_PATH, directory: Directory.External });
      // convertFileSrc turns file:// into https://localhost/_capacitor_file_/...
      // The WebView serves it with Range request support, so zip.js can fetch
      // individual entries without loading the whole file.
      return Capacitor.convertFileSrc(uri);
    } else {
      if (!this._webBuffer) throw new Error('No file in memory — download it first.');
      return URL.createObjectURL(new Blob([this._webBuffer]));
    }
  }

  /** Returns true if the file has been downloaded previously. */
  async fileExistsLocally(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
      try {
        await Filesystem.stat({ path: LOCAL_RELATIVE_PATH, directory: Directory.External });
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
        await Filesystem.deleteFile({ path: LOCAL_RELATIVE_PATH, directory: Directory.External });
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

    const destination = LOCAL_RELATIVE_PATH;

    console.log('[DownloadService] Saving file to:', destination);

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
          progress: data.progress,
        });
      }
    });
    listeners.push(progressListener);

    const completedListener = await CapacitorDownloader.addListener('downloadCompleted', async (result) => {
      if (result.id === DOWNLOAD_ID) {
        onProgress({
          status: DownloadStatus.Completed,
          progress: 100,
          localFileName: ServerConfig.localFileName,
        });
        cleanup();

        const fileInfo = await CapacitorDownloader.getFileInfo({ path: destination });
        console.log('ITS HERERERERERERE:', fileInfo);
      }
    });
    listeners.push(completedListener);

    const failedListener = await CapacitorDownloader.addListener('downloadFailed', (error) => {
      if (error.id === DOWNLOAD_ID) {
        console.log('It failed!');
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
        destination,
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

}

import { useEffect, useRef, useState } from 'react';
import esriConfig from '@arcgis/core/config.js';
import ArcGISMap from '@arcgis/core/Map.js';
import MapView from '@arcgis/core/views/MapView.js';
import TileLayer from '@arcgis/core/layers/TileLayer.js';
import Basemap from '@arcgis/core/Basemap.js';
import '@arcgis/core/assets/esri/themes/light/main.css';

import { DownloadService, DownloadStatus, DownloadProgress } from './download';
import { TileDatabase, getTileDatabase, parseAndStoreTpkFile } from './tpk';

esriConfig.assetsPath = './assets';

const downloadService = new DownloadService();

export default function App() {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const tileDatabaseRef = useRef<TileDatabase | null>(null);
  const [progress, setProgress] = useState<DownloadProgress>({ status: DownloadStatus.Idle, progress: 0 });
  const [hasCachedFile, setHasCachedFile] = useState(false);

  useEffect(() => {
    getTileDatabase().then((db) => { tileDatabaseRef.current = db; });
    return () => { tileDatabaseRef.current?.close(); };
  }, []);

  // Initialise map once
  useEffect(() => {
    if (!mapDivRef.current) return;

    const tileLayer = new TileLayer({
      url: 'https://services.geodataonline.no/arcgis/rest/services/Geocache_UTM33_EUREF89/GeocacheBilder/MapServer',
    });

    const basemap = new Basemap({ baseLayers: [tileLayer] });
    const map = new ArcGISMap({ basemap });

    const view = new MapView({
      container: mapDivRef.current,
      map,
      center: [14, 65],
      zoom: 5,
    });

    return () => { view.destroy(); };
  }, []);

  // Check for cached file on mount
  useEffect(() => {
    downloadService.fileExistsLocally().then((exists) => {
      setHasCachedFile(exists);
      if (exists) setProgress({ status: DownloadStatus.Idle, progress: 0 });
    });
  }, []);

  const startDownload = () => {
    downloadService.downloadFile((p) => {
      if (p.status === DownloadStatus.Completed) {
        setHasCachedFile(true);
        setProgress({ status: DownloadStatus.Idle, progress: 0 });
      } else {
        setProgress(p);
      }
    });
  };

  const handleDelete = async () => {
    await downloadService.deleteCachedFile();
    setHasCachedFile(false);
    setProgress({ status: DownloadStatus.Idle, progress: 0 });
  };

  const handleParseTpkFile = async () => {
    let start = performance.now();
    const tpk = await downloadService.getDownloadedTpkFile();
    const readingTime = performance.now() - start;

    start = performance.now();
    const db = tileDatabaseRef.current;
    if (!db) return;

    await parseAndStoreTpkFile(tpk, db);
    const parsingTime = performance.now() - start;

    console.log('Parsing tpk completed:')
    console.log(`  Reading file: ${readingTime} ms`)
    console.log(`  Parsing and storing: ${parsingTime} ms`)
    console.log(`  Total: ${readingTime + parsingTime} ms`)
  };

  const { status } = progress;
  const cached = hasCachedFile;

  return (
    <div id="app">
      <div ref={mapDivRef} id="viewDiv" />

      <div id="download-panel">
        <div className="status-row">
          <span className={`dot ${cached ? 'dot--green' : 'dot--blue'}`} />
          <span>{cached ? 'File cached locally' : 'No local cache!'}</span>
        </div>

        {status === DownloadStatus.Downloading && (
          <>
            <progress max={1} value={progress.progress} />
            <span className="progress-label">
              Downloading… {Math.round(progress.progress * 100)}%
            </span>
          </>
        )}

        {status === DownloadStatus.Failed && (
          <span className="error-label">
            Download failed: {progress.errorMessage ?? 'unknown error'}
          </span>
        )}

        {status === DownloadStatus.Idle && !cached && (
          <button className="btn btn--primary" onClick={startDownload}>
            Download offline file (.tpk)
          </button>
        )}

        {status === DownloadStatus.Failed && (
          <button className="btn btn--secondary" onClick={startDownload}>
            Retry
          </button>
        )}

        {cached && status !== DownloadStatus.Downloading && (
          <button className="btn btn--danger" onClick={handleDelete}>
            Remove cached file
          </button>
        )}
        {cached &&
          <button className="btn" onClick={handleParseTpkFile}>
            Parse cached file
          </button>
        }
      </div>
    </div>
  );
}

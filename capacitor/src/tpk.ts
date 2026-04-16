import { Capacitor } from '@capacitor/core'
import JSZip from 'jszip'

const TILE_CACHE = 'tpk-tiles-2'
const TPK_URL = '/data/basemap.tpk'
const LOCAL_TILE_BASE = '/tiles'

const TILE_SIZE = 256

async function readTileScheme(zip: any) {
  let confFile = null
  zip.forEach((path, file) => {
    if (!file.dir && path.endsWith('conf.xml') && !path.includes('_alllayers')) {
      confFile = file
    }
  })
  if (!confFile) return null

  const xml = new DOMParser().parseFromString(await confFile.async('text'), 'text/xml')
  const get = (tag) => xml.querySelector(tag)?.textContent?.trim()

  const originX = parseFloat(get('TileOrigin X'))
  const originY = parseFloat(get('TileOrigin Y'))

  const levels = {}
  xml.querySelectorAll('LODInfo').forEach((lod) => {
    const level = parseInt(lod.querySelector('LevelID')?.textContent)
    const resolution = parseFloat(lod.querySelector('Resolution')?.textContent)
    levels[level] = { resolution }
  })

  console.log('Tile scheme from conf.xml:', { originX, originY, levels })
  return { originX, originY, levels }
}

function detectContentType(buffer) {
  const b = new Uint8Array(buffer, 0, 4)
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  return 'image/jpg'
}

function parseBundleFilename(filename) {
  const match = filename.match(/R([0-9A-Fa-f]{4})C([0-9A-Fa-f]{4})\.bundle$/i)
  if (!match) return null
  return { rowStart: parseInt(match[1], 16), colStart: parseInt(match[2], 16) }
}

function parseZoom(path) {
  const match = path.match(/L(\d{2})\//)
  return match ? parseInt(match[1], 10) : null
}

function extractTiles(bundlxBuffer, bundleBuffer, arcgisLevel, rowStart, colStart, scheme) {
  const levelInfo = scheme.levels[arcgisLevel]
  if (!levelInfo) return []
  const { resolution } = levelInfo

  const indexView = new DataView(bundlxBuffer)
  const tiles = []

  for (let r = 0; r < 128; r++) {
    for (let c = 0; c < 128; c++) {
      const idxPos = 16 + (r * 128 + c) * 5
      const lo = indexView.getUint32(idxPos, true)
      const hi = indexView.getUint8(idxPos + 4)
      const offset = lo + hi * 0x100000000

      if (offset < 64 || offset + 4 > bundleBuffer.byteLength) continue

      const tileSize = new DataView(bundleBuffer, offset, 4).getUint32(0, true)
      if (tileSize === 0 || offset + 4 + tileSize > bundleBuffer.byteLength) continue

      const data = bundleBuffer.slice(offset + 4, offset + 4 + tileSize)

      // In compact cache bundlx, the index is col-major: i = r*128 + c
      // where r is the col offset and c is the row offset within the bundle
      const tileRow = rowStart + c
      const tileCol = colStart + r

      tiles.push({ zoom: arcgisLevel, tileRow, tileCol, data, contentType: detectContentType(data) })
    }
  }

  return tiles
}

async function storeTile(key: string, data: ArrayBuffer) {

}


export async function parseAndStoreTpkFile(tpk: ArrayBuffer, tile_db: TileDatabase) {
  const zip = await JSZip.loadAsync(tpk)

  const scheme = await readTileScheme(zip)
  if (!scheme || Object.keys(scheme.levels).length === 0) throw new Error('conf.xml not found or empty in .tpk')

  const bundleMap = new Map()
  zip.forEach((path, file) => {
    if (file.dir) return
    if (path.endsWith('.bundlx')) {
      const key = path.slice(0, -7)
      if (!bundleMap.has(key)) {
        bundleMap.set(key, {})
      }
      bundleMap.get(key).bundlx = file
    } else if (path.endsWith('.bundle')) {
      const key = path.slice(0, -7)
      if (!bundleMap.has(key)) {
        bundleMap.set(key, {})
      }
      bundleMap.get(key).bundle = file
    }
  })

  const pairs = [...bundleMap.entries()].filter(([, v]) => v.bundlx && v.bundle)
  if (pairs.length === 0) throw new Error('No bundle pairs found in .tpk')

  let bundlesDone = 0
  const zoomCounts: Record<number, number> = {}

  for (const [path, { bundlx, bundle }] of pairs) {
    const filename = path.split('/').pop()
    const coords = parseBundleFilename(filename + '.bundle')
    const arcgisLevel = parseZoom(path)
    if (!coords || arcgisLevel === null) { bundlesDone++; continue }

    const [bundlxBuffer, bundleBuffer] = await Promise.all([
      bundlx.async('arraybuffer'),
      bundle.async('arraybuffer'),
    ])

    const tiles = extractTiles(bundlxBuffer, bundleBuffer, arcgisLevel, coords.rowStart, coords.colStart, scheme)

    await Promise.all(tiles.map(({ zoom, tileRow, tileCol, data, contentType }) => {
      const url = `${LOCAL_TILE_BASE}/${zoom}/${tileRow}/${tileCol}.jpg`
      zoomCounts[zoom] = (zoomCounts[zoom] ?? 0) + 1

      return tile_db.putTile(zoom, tileRow, tileCol, data);
    }))

    bundlesDone++
  }

  console.log('Tiles cached per zoom level:', zoomCounts)
  return bundlesDone
}


export async function getTileDatabase(): Promise<TileDatabase> {
  if (Capacitor.isNativePlatform()) {
    throw new Error("Not implemented");
  }
  return await new TileDatabaseWeb().open();

}

interface Tile {
  tileKey: string;
  zoom: number;
  x: number;
  y: number;
  data: ArrayBuffer | Blob | string;
  storedAt: number;
}

interface RawTile {
  zoom: number;
  x: number;
  y: number;
  data: ArrayBuffer | Blob | string;
}


export interface TileDatabase {
  open(): Promise<this>;
  putTile(zoom: number, x: number, y: number, data: Tile["data"]): Promise<void>;
  putTiles(tiles: RawTile[]): Promise<void>;
  getTile(zoom: number, x: number, y: number): Promise<Tile | null>;
  clear(): Promise<void>;
  close(): void;
}

export class TileDatabaseWeb implements TileDatabase {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null = null;

  constructor(dbName = "TileDb", version = 1) {
    this.dbName = dbName;
    this.version = version;
  }

  open(): Promise<this> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("tiles")) {
          db.createObjectStore("tiles", { keyPath: "tileKey" });
        }
      }

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this);
      }

      request.onerror = (event) => {
        reject((event.target as IDBOpenDBRequest).error);
      }

    });
  }

  private get store(): IDBDatabase {
    if (!this.db) {
      throw new Error("Database is not open. Call open() first");
    }
    return this.db;
  }

  static tileKey(zoom: number, x: number, y: number): string {
    return `${zoom}/${x}/${y}`;
  }

  putTile(zoom: number, x: number, y: number, data: Tile["data"]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.store.transaction("tiles", "readwrite");
      const tile: Tile = {
        tileKey: TileDatabaseWeb.tileKey(zoom, x, y),
        zoom, x, y, data,
        storedAt: Date.now(),
      };
      const request = tx.objectStore("tiles").put(tile);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  putTiles(tiles: RawTile[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.store.transaction("tiles", "readwrite");
      const store = tx.objectStore("tiles");
      const now = Date.now();

      for (const { zoom, x, y, data } of tiles) {
        store.put({
          tileKey: TileDatabaseWeb.tileKey(zoom, x, y),
          zoom, x, y, data,
          storedAt: now,
        } satisfies Tile);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  getTile(zoom: number, x: number, y: number): Promise<Tile | null> {
    return new Promise((resolve, reject) => {
      const tx = this.store.transaction("tiles", "readonly");
      const request = tx.objectStore("tiles").get(TileDatabaseWeb.tileKey(zoom, x, y));
      request.onsuccess = () => resolve((request.result as Tile) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.store.transaction("tiles", "readwrite");
      const request = tx.objectStore("tiles").clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}




import { Capacitor } from '@capacitor/core'
import { ZipReader, HttpReader, Uint8ArrayWriter, TextWriter } from '@zip.js/zip.js'
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'

type ZipEntry = Awaited<ReturnType<ZipReader['getEntries']>>[number];

interface LevelInfo {
  resolution: number;
}

interface TileScheme {
  originX: number;
  originY: number;
  levels: Record<number, LevelInfo>;
}

interface BundleCoords {
  rowStart: number;
  colStart: number;
}

interface RawExtractedTile {
  zoom: number;
  tileRow: number;
  tileCol: number;
  data: ArrayBuffer;
  contentType: string;
}

async function readTileScheme(entries: ZipEntry[]): Promise<TileScheme | null> {
  const confEntry = entries.find(
    e => !e.directory && e.filename.endsWith('conf.xml') && !e.filename.includes('_alllayers'),
  );
  if (!confEntry) return null;

  const text = await confEntry.getData(new TextWriter());
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  const get = (tag: string): string | undefined => xml.querySelector(tag)?.textContent?.trim();

  const originX = parseFloat(get('TileOrigin X') ?? 'NaN');
  const originY = parseFloat(get('TileOrigin Y') ?? 'NaN');

  const levels: Record<number, LevelInfo> = {};
  xml.querySelectorAll('LODInfo').forEach((lod) => {
    const level = parseInt(lod.querySelector('LevelID')?.textContent ?? '');
    const resolution = parseFloat(lod.querySelector('Resolution')?.textContent ?? 'NaN');
    levels[level] = { resolution };
  });

  console.log('Tile scheme from conf.xml:', { originX, originY, levels });
  return { originX, originY, levels };
}

function detectContentType(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer, 0, 4);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return 'image/jpg';
}

function parseBundleFilename(filename: string): BundleCoords | null {
  const match = filename.match(/R([0-9A-Fa-f]{4})C([0-9A-Fa-f]{4})\.bundle$/i);
  if (!match) return null;
  return { rowStart: parseInt(match[1], 16), colStart: parseInt(match[2], 16) };
}

function parseZoom(path: string): number | null {
  const match = path.match(/L(\d{2})\//);
  return match ? parseInt(match[1], 10) : null;
}

function extractTiles(
  bundlxBuffer: ArrayBuffer,
  bundleBuffer: ArrayBuffer,
  arcgisLevel: number,
  rowStart: number,
  colStart: number,
  scheme: TileScheme,
): RawExtractedTile[] {
  const levelInfo = scheme.levels[arcgisLevel];
  if (!levelInfo) return [];

  const indexView = new DataView(bundlxBuffer);
  const tiles: RawExtractedTile[] = [];

  for (let r = 0; r < 128; r++) {
    for (let c = 0; c < 128; c++) {
      const idxPos = 16 + (r * 128 + c) * 5;
      const lo = indexView.getUint32(idxPos, true);
      const hi = indexView.getUint8(idxPos + 4);
      const offset = lo + hi * 0x100000000;

      if (offset < 64 || offset + 4 > bundleBuffer.byteLength) continue;

      const tileSize = new DataView(bundleBuffer, offset, 4).getUint32(0, true);
      if (tileSize === 0 || offset + 4 + tileSize > bundleBuffer.byteLength) continue;

      const data = bundleBuffer.slice(offset + 4, offset + 4 + tileSize);

      // In compact cache bundlx, the index is col-major: i = r*128 + c
      // where r is the col offset and c is the row offset within the bundle
      const tileRow = rowStart + c;
      const tileCol = colStart + r;

      tiles.push({ zoom: arcgisLevel, tileRow, tileCol, data, contentType: detectContentType(data) });
    }
  }

  return tiles;
}

export async function parseAndStoreTpkFile(tpkUrl: string, tile_db: TileDatabase): Promise<number> {
  const zipReader = new ZipReader(new HttpReader(tpkUrl));

  // getEntries() only fetches the central directory via Range requests — not the file data.
  const entries = await zipReader.getEntries();

  const scheme = await readTileScheme(entries);
  if (!scheme || Object.keys(scheme.levels).length === 0) {
    await zipReader.close();
    throw new Error('conf.xml not found or empty in .tpk');
  }

  const bundleMap = new Map<string, { bundlx?: ZipEntry; bundle?: ZipEntry }>();
  for (const entry of entries) {
    if (entry.directory) continue;
    if (entry.filename.endsWith('.bundlx')) {
      const key = entry.filename.slice(0, -7);
      if (!bundleMap.has(key)) bundleMap.set(key, {});
      bundleMap.get(key)!.bundlx = entry;
    } else if (entry.filename.endsWith('.bundle')) {
      const key = entry.filename.slice(0, -7);
      if (!bundleMap.has(key)) bundleMap.set(key, {});
      bundleMap.get(key)!.bundle = entry;
    }
  }

  const pairs = [...bundleMap.entries()].filter(([, v]) => v.bundlx && v.bundle);
  if (pairs.length === 0) {
    await zipReader.close();
    throw new Error('No bundle pairs found in .tpk');
  }

  let bundlesDone = 0;
  const zoomCounts: Record<number, number> = {};

  for (const [path, { bundlx, bundle }] of pairs) {
    console.log('MYLOG: GEt dat bundle');
    const filename = path.split('/').pop();
    const coords = parseBundleFilename((filename ?? '') + '.bundle');
    const arcgisLevel = parseZoom(path);
    if (!coords || arcgisLevel === null) { bundlesDone++; continue; }

    // Each getData() fetches only this entry's bytes via a Range request.
    // Processing pairs sequentially keeps only ~one bundle pair in memory at a time.
    const [bundlxData, bundleData] = await Promise.all([
      bundlx!.getData(new Uint8ArrayWriter()),
      bundle!.getData(new Uint8ArrayWriter()),
    ]);

    const tiles = extractTiles(
      bundlxData.buffer as ArrayBuffer,
      bundleData.buffer as ArrayBuffer,
      arcgisLevel,
      coords.rowStart,
      coords.colStart,
      scheme,
    );

    const rawTiles = tiles.map(({ zoom, tileRow, tileCol, data }) => {
      zoomCounts[zoom] = (zoomCounts[zoom] ?? 0) + 1;
      return { zoom, x: tileRow, y: tileCol, data };
    });
    await tile_db.putTiles(rawTiles);

    // Yield to the event loop so the GC can collect the bundle buffers
    // before the next pair is fetched.
    await new Promise(r => setTimeout(r, 0));
    bundlesDone++;
  }

  await zipReader.close();
  console.log('Tiles cached per zoom level:', zoomCounts);
  return bundlesDone;
}

export async function getTileDatabase(): Promise<TileDatabase> {
  if (Capacitor.isNativePlatform()) {
    return await new TileDatabaseNative().open();
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
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this);
      };

      request.onerror = (event) => {
        reject((event.target as IDBOpenDBRequest).error);
      };
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

// ---------------------------------------------------------------------------
// Helpers for binary ↔ base64 (SQLite TEXT storage for BLOB data)
// ---------------------------------------------------------------------------

function arrayBufferToBase64(data: ArrayBuffer | Blob | string): string {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) throw new Error('Blob input is not supported in TileDatabaseNative');
  const bytes = new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Native implementation — backed by @capacitor-community/sqlite
// ---------------------------------------------------------------------------

export class TileDatabaseNative implements TileDatabase {
  private readonly dbName: string;
  private readonly version: number;
  private readonly sqlite: SQLiteConnection;
  private db: SQLiteDBConnection | null = null;

  constructor(dbName = 'TileDb', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  async open(): Promise<this> {
    this.db = await this.sqlite.createConnection(
      this.dbName,
      false,
      'no-encryption',
      this.version,
      false,
    );
    await this.db.open();
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS tiles (
        tileKey  TEXT    PRIMARY KEY NOT NULL,
        zoom     INTEGER NOT NULL,
        x        INTEGER NOT NULL,
        y        INTEGER NOT NULL,
        data     TEXT    NOT NULL,
        storedAt INTEGER NOT NULL
      );
    `);
    return this;
  }

  private get conn(): SQLiteDBConnection {
    if (!this.db) throw new Error('Database is not open. Call open() first');
    return this.db;
  }

  static tileKey(zoom: number, x: number, y: number): string {
    return `${zoom}/${x}/${y}`;
  }

  async putTile(zoom: number, x: number, y: number, data: Tile['data']): Promise<void> {
    await this.conn.run(
      'INSERT OR REPLACE INTO tiles (tileKey, zoom, x, y, data, storedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [TileDatabaseNative.tileKey(zoom, x, y), zoom, x, y, arrayBufferToBase64(data), Date.now()],
    );
  }

  async putTiles(tiles: RawTile[]): Promise<void> {
    const CHUNK_SIZE = 200;
    const now = Date.now();
    const stmt = 'INSERT OR REPLACE INTO tiles (tileKey, zoom, x, y, data, storedAt) VALUES (?, ?, ?, ?, ?, ?)';

    await this.conn.beginTransaction();
    try {
      for (let i = 0; i < tiles.length; i += CHUNK_SIZE) {
        // Only CHUNK_SIZE base64 strings exist in memory at a time.
        const set = tiles.slice(i, i + CHUNK_SIZE).map(({ zoom, x, y, data }) => ({
          statement: stmt,
          values: [TileDatabaseNative.tileKey(zoom, x, y), zoom, x, y, arrayBufferToBase64(data), now],
        }));
        await this.conn.executeSet(set, false);
      }
      await this.conn.commitTransaction();
    } catch (e) {
      await this.conn.rollbackTransaction();
      throw e;
    }
  }

  async getTile(zoom: number, x: number, y: number): Promise<Tile | null> {
    const result = await this.conn.query(
      'SELECT tileKey, zoom, x, y, data, storedAt FROM tiles WHERE tileKey = ?',
      [TileDatabaseNative.tileKey(zoom, x, y)],
    );
    const row = result.values?.[0];
    if (!row) return null;
    return {
      tileKey: row.tileKey as string,
      zoom: row.zoom as number,
      x: row.x as number,
      y: row.y as number,
      data: base64ToArrayBuffer(row.data as string),
      storedAt: row.storedAt as number,
    };
  }

  async clear(): Promise<void> {
    await this.conn.execute('DELETE FROM tiles');
  }

  close(): void {
    // SQLiteDBConnection.close() is async; fire-and-forget to match the sync interface.
    this.db?.close().catch(console.error);
    this.db = null;
  }
}

import { Capacitor } from "@capacitor/core";

/**
 * Configuration for the file server hosting the .tpk (or any large file).
 * Replace the placeholder values with your actual server details.
 */
export const ServerConfig = {

  /** Base URL of the file server. Uses a local Vite proxy in dev to avoid CORS. */
  get serverUrl(): string {
    if (Capacitor.isNativePlatform()) {
      return 'https://tpk.allma.no';
    }
    return '/tpk-proxy';
  },
  //serverUrl: import.meta.env.DEV ? '/tpk-proxy' : 'https://tpk.allma.no',

  /** Username for HTTP Basic Auth. */
  username: '',

  /** Password for HTTP Basic Auth. */
  password: '',

  /** Path to the file on the server. Example: '/files/norway_basemap.tpk' */
  filePath: '/GeocacheBasis_kommunevis_L14_Trondheim_5001.tpk',

  /** Name used when saving the file locally via Capacitor Filesystem. */
  localFileName: 'trondheim_basemap.tpk',

  /** Full download URL. */
  get fileUrl(): string {
    return `${this.serverUrl}${this.filePath}`;
  },
};

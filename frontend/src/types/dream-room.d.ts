/**
 * DreamRoom type shim.
 *
 * DreamRoom is the full "her room" view. It is loaded lazily by the renderer
 * entry and bundled by Vite, but its files are excluded from the strict
 * TypeScript check (they predate the strict MVP closure). tsconfig paths map
 * the DreamRoom import here so `tsc` sees a checked, narrow surface while
 * Vite/esbuild compiles the real implementation at build time.
 */
import type React from 'react';

declare const DreamRoom: React.ComponentType<Record<string, never>>;
export default DreamRoom;

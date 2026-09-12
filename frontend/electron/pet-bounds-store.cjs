'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'reverie.pet-bounds.v1';

function clampBounds(saved, displays, fallback, minimum = { width: 360, height: 520 }) {
  const candidates = Array.isArray(displays) ? displays.filter((item) => item?.workArea) : [];
  const preferred = candidates.find((item) => String(item.id) === String(saved?.displayId))
    || candidates.find((item) => {
      const area = item.workArea;
      const x = Number(saved?.bounds?.x);
      const y = Number(saved?.bounds?.y);
      return Number.isFinite(x) && Number.isFinite(y)
        && x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
    })
    || candidates[0];
  if (!preferred) return { ...fallback };
  const area = preferred.workArea;
  const savedX = Number(saved?.bounds?.x);
  const savedY = Number(saved?.bounds?.y);
  const width = Math.min(area.width, Math.max(minimum.width, Number(saved?.bounds?.width) || fallback.width));
  const height = Math.min(area.height, Math.max(minimum.height, Number(saved?.bounds?.height) || fallback.height));
  // A legitimate edge position (x=0 / y=0) must survive the restore round-trip.
  const x = Math.min(area.x + area.width - width, Math.max(area.x, Number.isFinite(savedX) ? savedX : fallback.x));
  const y = Math.min(area.y + area.height - height, Math.max(area.y, Number.isFinite(savedY) ? savedY : fallback.y));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

class PetBoundsStore {
  constructor(storageDir) {
    this.file = path.join(path.resolve(storageDir), 'pet-bounds.json');
  }

  load() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value?.schema !== SCHEMA || !value.bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value.bounds[key]))) return null;
      return value;
    } catch { return null; }
  }

  save(displayId, bounds, scaleFactor = 1) {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const value = { schema: SCHEMA, displayId: String(displayId), scaleFactor, bounds, savedAtUtc: new Date().toISOString() };
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.file);
    return value;
  }
}

module.exports = { PetBoundsStore, SCHEMA, clampBounds };

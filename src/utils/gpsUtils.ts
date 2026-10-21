import { ImageFile } from '../components/ui/AppProperties';

export interface GeoLocation {
  lat: number;
  lon: number;
}

export function parseGpsCoordinate(coordStr: string): number | null {
  if (!coordStr) return null;
  const trimmed = coordStr.trim();

  // 1. Deg / Min / Sec format (e.g. "45 deg 27 min 51.12 sec" or "45° 27' 51.12\"")
  const dmsMatch = trimmed.match(
    /(\d+\.?\d*)\s*(?:deg|°)\s*(\d+\.?\d*)\s*(?:min|'|’|′)\s*(\d+\.?\d*)\s*(?:sec|"|”|″)?/i,
  );
  if (dmsMatch) {
    const deg = parseFloat(dmsMatch[1]);
    const min = parseFloat(dmsMatch[2]);
    const sec = parseFloat(dmsMatch[3]);
    if (!isNaN(deg) && !isNaN(min) && !isNaN(sec)) {
      return deg + min / 60 + sec / 3600;
    }
  }

  // 2. Comma separated deg, min, sec (e.g. "45, 27, 51.12")
  const commaParts = trimmed.split(/,\s*/);
  if (commaParts.length === 3) {
    const deg = parseFloat(commaParts[0]);
    const min = parseFloat(commaParts[1]);
    const sec = parseFloat(commaParts[2]);
    if (!isNaN(deg) && !isNaN(min) && !isNaN(sec)) {
      return deg + min / 60 + sec / 3600;
    }
  }

  // 3. Direct decimal degrees float (e.g. "45.4642")
  const directVal = parseFloat(trimmed);
  if (!isNaN(directVal) && isFinite(directVal)) {
    return directVal;
  }

  return null;
}

export function getImageGps(
  image: ImageFile,
  overrideExif?: Record<string, string>,
): GeoLocation | null {
  const exif = overrideExif !== undefined ? overrideExif : image.exif;
  if (!exif) return null;

  const latStr = exif.GPSLatitude;
  const latRef = exif.GPSLatitudeRef;
  const lonStr = exif.GPSLongitude;
  const lonRef = exif.GPSLongitudeRef;

  if (!latStr || !lonStr) return null;

  let lat = parseGpsCoordinate(latStr);
  let lon = parseGpsCoordinate(lonStr);

  if (lat === null || lon === null) return null;

  if (latRef && latRef.toUpperCase().startsWith('S')) {
    lat = -Math.abs(lat);
  }
  if (lonRef && lonRef.toUpperCase().startsWith('W')) {
    lon = -Math.abs(lon);
  }

  // Validate standard latitude [-90, 90] and longitude [-180, 180]
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  // Ignore Null Island (0, 0) placeholder often written by cameras before acquiring GPS lock
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) {
    return null;
  }

  return { lat, lon };
}

export function getImageTimestamp(
  image: ImageFile,
  overrideExif?: Record<string, string>,
): string | null {
  const exif = overrideExif !== undefined ? overrideExif : image.exif;
  if (exif) {
    const dt = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || exif.DateTime;
    if (dt) return dt;
  }
  if (image.modified) {
    try {
      return new Date(image.modified * 1000).toLocaleString();
    } catch {
      return null;
    }
  }
  return null;
}

export function toDmsString(val: number): string {
  const absVal = Math.abs(val);
  const deg = Math.floor(absVal);
  const minFull = (absVal - deg) * 60;
  const min = Math.floor(minFull);
  const sec = (minFull - min) * 60;
  return `${deg} deg ${min} min ${sec.toFixed(2)} sec`;
}

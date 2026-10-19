import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from '../../../utils/leaflet-setup';
import 'leaflet.markercluster';
import { invoke } from '@tauri-apps/api/core';
import {
  Maximize2,
  Layers,
  Image as ImageIcon,
  MapPin,
  MapPinOff,
  PanelRightClose,
  PanelRightOpen,
  CheckCircle2,
  GripVertical,
  Undo2,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import debounce from 'lodash.debounce';
import { ImageFile, Invokes } from '../../ui/AppProperties';
import { useProcessStore } from '../../../store/useProcessStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useEditorStore } from '../../../store/useEditorStore';
import { getImageGps, getImageTimestamp, GeoLocation } from '../../../utils/gpsUtils';
import clsx from 'clsx';
import { IconAperture, IconFocalLength, IconIso, IconShutter } from '../editor/ExifIcons';

export type MapStyle = 'dark' | 'osm' | 'satellite';

interface MapLayerConfig {
  id: MapStyle;
  label: string;
  icon: string;
  url: string;
  attribution: string;
  className?: string;
  maxZoom: number;
}

const MAP_LAYERS: Record<MapStyle, MapLayerConfig> = {
  dark: {
    id: 'dark',
    label: 'Dark OSM',
    icon: '🌙',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: 'dark-map-tiles',
    maxZoom: 19,
  },
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    icon: '☀️',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: '',
    maxZoom: 19,
  },
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    icon: '🛰️',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and GIS User Community',
    className: '',
    maxZoom: 19,
  },
};

const MAP_STYLE_STORAGE_KEY = 'rapidraw_map_tile_style';
const MAP_SHOW_THUMBNAILS_STORAGE_KEY = 'rapidraw_map_show_thumbnails';
const MAP_DOCK_OPEN_STORAGE_KEY = 'rapidraw_map_dock_open';
const MAP_DOCK_WIDTH_STORAGE_KEY = 'rapidraw_map_dock_width';

function getInitialMapStyle(): MapStyle {
  try {
    const saved = localStorage.getItem(MAP_STYLE_STORAGE_KEY);
    if (saved && (saved === 'dark' || saved === 'osm' || saved === 'satellite')) {
      return saved as MapStyle;
    }
  } catch (e) {
    console.error('Failed to read map style from localStorage', e);
  }
  return 'dark';
}

function getInitialShowThumbnails(): boolean {
  try {
    const saved = localStorage.getItem(MAP_SHOW_THUMBNAILS_STORAGE_KEY);
    if (saved !== null) {
      return saved === 'true';
    }
  } catch (e) {
    console.error('Failed to read show thumbnails setting from localStorage', e);
  }
  return true;
}

function getInitialDockOpen(): boolean {
  try {
    const saved = localStorage.getItem(MAP_DOCK_OPEN_STORAGE_KEY);
    if (saved !== null) {
      return saved === 'true';
    }
  } catch (e) {
    console.error('Failed to read dock open setting from localStorage', e);
  }
  return true;
}

function getInitialDockWidth(): number {
  try {
    const saved = localStorage.getItem(MAP_DOCK_WIDTH_STORAGE_KEY);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 160 && parsed <= 550) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to read dock width setting from localStorage', e);
  }
  return 260;
}

function toDmsString(val: number): string {
  const absVal = Math.abs(val);
  const deg = Math.floor(absVal);
  const minFull = (absVal - deg) * 60;
  const min = Math.floor(minFull);
  const sec = (minFull - min) * 60;
  return `${deg} deg ${min} min ${sec.toFixed(4)} sec`;
}

interface MapPhotoItem {
  id: string;
  path: string;
  filename: string;
  lat: number;
  lon: number;
  timestamp: string | null;
  isRaw: boolean;
  image: ImageFile;
  hasNativeGps: boolean;
  isGpsModified: boolean;
}

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop()!.toUpperCase() : '';
}

function createCustomPin(isSelected: boolean, isRaw: boolean): L.DivIcon {
  const primaryColor = isSelected ? '#38bdf8' : isRaw ? '#f59e0b' : '#0284c7';
  const glow = isSelected ? 'filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.9));' : '';

  const html = `
    <div style="${glow} transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); transform: ${
      isSelected ? 'scale(1.25)' : 'scale(1)'
    }; cursor: pointer;">
      <svg width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 0C6.268 0 0 6.268 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.268 21.732 0 14 0Z" fill="${primaryColor}"/>
        <circle cx="14" cy="14" r="11" fill="#0f172a"/>
        <circle cx="14" cy="14" r="5" fill="${primaryColor}"/>
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-photo-pin',
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -32],
  });
}

function createThumbnailLoadingPin(isSelected: boolean, isRaw: boolean, _filename: string): L.DivIcon {
  const borderColor = isSelected ? '#38bdf8' : isRaw ? '#f59e0b' : '#0284c7';
  const glow = isSelected
    ? 'box-shadow: 0 0 16px rgba(56, 189, 248, 0.9), 0 4px 10px rgba(0, 0, 0, 0.6);'
    : 'box-shadow: 0 4px 10px rgba(0, 0, 0, 0.6);';
  const scale = isSelected ? 'scale(1.15)' : 'scale(1)';

  const html = `
    <div style="position: relative; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); transform: ${scale}; cursor: pointer; display: flex; flex-direction: column; align-items: center;">
      <div style="
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: ${isSelected ? '3px' : '2px'} solid ${borderColor};
        overflow: hidden;
        background-color: #0f172a;
        ${glow}
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      ">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${borderColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.6;">
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
          <circle cx="9" cy="9" r="2"/>
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
        </svg>
      </div>
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid ${borderColor};
        margin-top: -1px;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-thumbnail-pin-loading',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
    popupAnchor: [0, -100],
  });
}

function createPhotoThumbnailPin(
  thumbnailUrl: string,
  isSelected: boolean,
  isRaw: boolean,
  filename: string,
): L.DivIcon {
  const borderColor = isSelected ? '#38bdf8' : isRaw ? '#f59e0b' : '#0284c7';
  const glow = isSelected
    ? 'box-shadow: 0 0 16px rgba(56, 189, 248, 0.9), 0 4px 10px rgba(0, 0, 0, 0.6);'
    : 'box-shadow: 0 4px 10px rgba(0, 0, 0, 0.6);';
  const scale = isSelected ? 'scale(1.15)' : 'scale(1)';

  const html = `
    <div style="position: relative; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); transform: ${scale}; cursor: pointer; display: flex; flex-direction: column; align-items: center;">
      <div style="
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: ${isSelected ? '3px' : '2px'} solid ${borderColor};
        overflow: hidden;
        background-color: #0b0f19;
        ${glow}
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      ">
        <img
          src="${thumbnailUrl}"
          alt="${filename}"
          style="width: 100%; height: 100%; object-fit: cover; display: block;"
          loading="eager"
        />
      </div>
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid ${borderColor};
        margin-top: -1px;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-thumbnail-pin',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
    popupAnchor: [0, -100],
  });
}

function createClusterThumbnailPin(
  thumbnailUrl: string,
  count: number,
  clusterId?: number,
  activeIndex?: number,
): L.DivIcon {
  const countLabel =
    activeIndex !== undefined
      ? `${activeIndex + 1}/${count}`
      : count > 999
        ? '999+'
        : count.toString();

  const html = `
    <div data-cluster-id="${clusterId ?? ''}" style="position: relative; cursor: pointer; display: flex; flex-direction: column; align-items: center; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);">
      <!-- Stack background card 2 (bottom layer) -->
      <div style="
        position: absolute;
        width: 90px;
        height: 90px;
        top: -4px;
        left: 5px;
        border-radius: 12px;
        background: #0f172a;
        border: 2px solid rgba(56, 189, 248, 0.35);
        transform: rotate(4deg);
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.5);
      "></div>

      <!-- Stack background card 1 (middle layer) -->
      <div style="
        position: absolute;
        width: 93px;
        height: 93px;
        top: -2px;
        left: 1px;
        border-radius: 12px;
        background: #1e293b;
        border: 2px solid rgba(56, 189, 248, 0.6);
        transform: rotate(-3deg);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
      "></div>

      <!-- Front main card with thumbnail -->
      <div style="
        position: relative;
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: 3px solid #38bdf8;
        overflow: hidden;
        background-color: #0b0f19;
        box-shadow: 0 0 16px rgba(56, 189, 248, 0.5), 0 8px 16px rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <img
          src="${thumbnailUrl}"
          alt="Cluster"
          style="width: 100%; height: 100%; object-fit: cover; display: block;"
          loading="eager"
        />

        <!-- Count Badge in top-right corner with layers icon -->
        <div style="
          position: absolute;
          top: 4px;
          right: 4px;
          background: #0284c7;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          padding: 2px 6px;
          border-radius: 9999px;
          border: 1.5px solid #38bdf8;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
          display: flex;
          align-items: center;
          gap: 3px;
          z-index: 10;
        ">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9;">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
          <span data-cluster-badge>${countLabel}</span>
        </div>
      </div>

      <!-- Pointer triangle -->
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid #38bdf8;
        margin-top: -1px;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-cluster-thumbnail-pin',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
  });
}

function createClusterLoadingPin(count: number, clusterId?: number, activeIndex?: number): L.DivIcon {
  const countLabel =
    activeIndex !== undefined
      ? `${activeIndex + 1}/${count}`
      : count > 999
        ? '999+'
        : count.toString();

  const html = `
    <div data-cluster-id="${clusterId ?? ''}" style="position: relative; cursor: pointer; display: flex; flex-direction: column; align-items: center; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);">
      <!-- Stack background card 2 -->
      <div style="
        position: absolute;
        width: 90px;
        height: 90px;
        top: -4px;
        left: 5px;
        border-radius: 12px;
        background: #0f172a;
        border: 2px solid rgba(56, 189, 248, 0.35);
        transform: rotate(4deg);
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.5);
      "></div>

      <!-- Stack background card 1 -->
      <div style="
        position: absolute;
        width: 93px;
        height: 93px;
        top: -2px;
        left: 1px;
        border-radius: 12px;
        background: #1e293b;
        border: 2px solid rgba(56, 189, 248, 0.6);
        transform: rotate(-3deg);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
      "></div>

      <!-- Front card placeholder -->
      <div style="
        position: relative;
        width: 96px;
        height: 96px;
        border-radius: 12px;
        border: 3px solid #38bdf8;
        overflow: hidden;
        background-color: #0f172a;
        box-shadow: 0 0 16px rgba(56, 189, 248, 0.5), 0 8px 16px rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.6;">
          <polygon points="12 2 2 7 12 12 22 7 12 2"/>
          <polyline points="2 17 12 22 22 17"/>
          <polyline points="2 12 12 17 22 12"/>
        </svg>

        <!-- Count Badge in top-right corner with layers icon -->
        <div style="
          position: absolute;
          top: 4px;
          right: 4px;
          background: #0284c7;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          padding: 2px 6px;
          border-radius: 9999px;
          border: 1.5px solid #38bdf8;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
          display: flex;
          align-items: center;
          gap: 3px;
          z-index: 10;
        ">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.9;">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
          <span data-cluster-badge>${countLabel}</span>
        </div>
      </div>

      <!-- Pointer triangle -->
      <div style="
        width: 0;
        height: 0;
        border-left: 9px solid transparent;
        border-right: 9px solid transparent;
        border-top: 10px solid #38bdf8;
        margin-top: -1px;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'photo-cluster-thumbnail-pin-loading',
    iconSize: [96, 106],
    iconAnchor: [48, 106],
  });
}

function createCompactClusterPin(count: number, clusterId?: number): L.DivIcon {
  const countLabel = count > 999 ? '999+' : count.toString();
  const c = count < 10 ? 'small' : count < 100 ? 'medium' : 'large';
  return L.divIcon({
    html: `<div data-cluster-id="${clusterId ?? ''}"><span>${countLabel}</span></div>`,
    className: `marker-cluster marker-cluster-${c}`,
    iconSize: new L.Point(40, 40),
  });
}

function buildPopupHtml(
  photo: MapPhotoItem,
  thumbUrl: string | undefined,
  dblClickHint: string,
  revertGpsText: string,
  dragHintText: string,
): string {
  const ext = getFileExtension(photo.filename);

  return `
    <div style="font-family: inherit; font-size: 13px; color: #f8fafc; width: 480px; max-width: 520px;" data-photo-path="${photo.path}">
      ${
        thumbUrl
          ? `<div style="width: 100%; height: 260px; border-radius: 8px; overflow: hidden; margin-bottom: 12px; background: #0b0f19; border: 1px solid #334155; cursor: pointer;">
               <img src="${thumbUrl}" alt="${photo.filename}" style="width: 100%; height: 100%; object-fit: cover; display: block;" />
             </div>`
          : ''
      }
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px;">
        <span style="font-weight: 600; font-size: 15px; color: #fff; word-break: break-all;">
          ${photo.filename}
        </span>
        <span style="
          font-size: 11px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 5px;
          background-color: ${photo.isRaw ? '#78350f' : '#0c4a6e'};
          color: ${photo.isRaw ? '#fde68a' : '#bae6fd'};
          border: 1px solid ${photo.isRaw ? '#d97706' : '#0284c7'};
        ">
          ${ext || 'IMG'}
        </span>
      </div>

      ${
        photo.timestamp
          ? `<div style="display: flex; align-items: center; gap: 6px; color: #94a3b8; font-size: 12px; margin-bottom: 5px;">
               <span>📅 ${photo.timestamp}</span>
             </div>`
          : ''
      }

      <div style="display: flex; align-items: center; gap: 6px; color: #38bdf8; font-family: monospace; font-size: 12px; margin-bottom: 4px;">
        <span>📍 ${photo.lat.toFixed(6)}°, ${photo.lon.toFixed(6)}°</span>
      </div>

      <div style="display: flex; align-items: center; gap: 5px; color: #94a3b8; font-size: 11px; margin-bottom: 8px; opacity: 0.85;">
        <span>✋ ${dragHintText}</span>
      </div>

      <div style="color: #64748b; font-size: 11px; word-break: break-all; margin-bottom: 8px;">
        ${photo.path}
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #334155; padding-top: 8px; gap: 8px;">
        <span style="font-size: 11px; color: #38bdf8; opacity: 0.9;">
          ${dblClickHint}
        </span>
        <div style="display: flex; align-items: center; gap: 6px;">
          <button
            data-action="revert-gps"
            data-path="${photo.path}"
            style="background: rgba(14, 165, 233, 0.15); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.4); border-radius: 4px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;"
            title="${revertGpsText}"
          >
            ↺ ${revertGpsText}
          </button>
        </div>
      </div>
    </div>
  `;
}

interface PhotoClusterLayerProps {
  photos: MapPhotoItem[];
  selectedPath: string | null;
  currentFolderPath?: string | null;
  onSelectPhoto: (path: string, event: MouseEvent) => void;
  onDoubleClickPhoto: (path: string) => void;
  onContextMenuPhoto: (event: MouseEvent, path: string) => void;
  onRevertGps?: (path: string) => void;
  onMovePhoto?: (path: string, lat: number, lon: number) => void;
  onMapContextMenu?: (lat: number, lon: number, screenX: number, screenY: number) => void;
  showThumbnailCards: boolean;
  onRequestThumbnails?: (paths: string[]) => void;
}

const PhotoClusterLayer: React.FC<PhotoClusterLayerProps> = ({
  photos,
  selectedPath,
  currentFolderPath,
  onSelectPhoto,
  onDoubleClickPhoto,
  onContextMenuPhoto,
  onRevertGps,
  onMovePhoto,
  onMapContextMenu,
  showThumbnailCards,
  onRequestThumbnails,
}) => {
  const map = useMap();
  const [cluster, setCluster] = useState<L.MarkerClusterGroup | null>(null);
  const markersMapRef = useRef<Map<string, L.Marker>>(new Map());
  const clustersMapRef = useRef<Map<number, L.MarkerCluster>>(new Map());
  const isWheelSelectingRef = useRef<boolean>(false);
  const hasInitialFitRef = useRef<boolean>(false);
  const prevSelectedPathRef = useRef<string | null>(null);
  const hasZoomedToInitialRef = useRef<boolean>(false);
  const prevThumbnailsKeysRef = useRef<Set<string>>(new Set());
  const thumbnails = useProcessStore((s) => s.thumbnails);
  const { t } = useTranslation();

  const selectedPathRef = useRef<string | null>(selectedPath);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const onRequestThumbnailsRef = useRef(onRequestThumbnails);
  useEffect(() => {
    onRequestThumbnailsRef.current = onRequestThumbnails;
  }, [onRequestThumbnails]);

  const onSelectPhotoRef = useRef(onSelectPhoto);
  useEffect(() => {
    onSelectPhotoRef.current = onSelectPhoto;
  }, [onSelectPhoto]);

  const showThumbnailCardsRef = useRef<boolean>(showThumbnailCards);
  useEffect(() => {
    showThumbnailCardsRef.current = showThumbnailCards;
  }, [showThumbnailCards]);

  // Reset initial fit and zoom flags when switching folders
  useEffect(() => {
    hasInitialFitRef.current = false;
    hasZoomedToInitialRef.current = false;
  }, [currentFolderPath]);

  const dblClickHint = t('library.map.doubleClickHint', {
    defaultValue: 'Double click to open in Adjustments mode',
  });
  const revertGpsText = t('library.map.revertGpsData', {
    defaultValue: 'Revert GPS data',
  });
  const dragHintText = t('library.map.dragToReposition', {
    defaultValue: 'Drag pin to reposition',
  });

  const onRevertGpsRef = useRef(onRevertGps);
  useEffect(() => {
    onRevertGpsRef.current = onRevertGps;
  }, [onRevertGps]);

  const onMovePhotoRef = useRef(onMovePhoto);
  useEffect(() => {
    onMovePhotoRef.current = onMovePhoto;
  }, [onMovePhoto]);

  const onMapContextMenuRef = useRef(onMapContextMenu);
  useEffect(() => {
    onMapContextMenuRef.current = onMapContextMenu;
  }, [onMapContextMenu]);

  // Round-robin mouse wheel photo cycling on clusters
  useEffect(() => {
    const container = map.getContainer();

    const handleWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      const clusterEl = target?.closest('[data-cluster-id]') as HTMLElement | null;
      if (!clusterEl) return;

      const clusterIdStr = clusterEl.getAttribute('data-cluster-id');
      if (!clusterIdStr) return;

      const clusterId = Number(clusterIdStr);
      const clusterMarker = clustersMapRef.current.get(clusterId);
      if (!clusterMarker) return;

      const childMarkers = clusterMarker.getAllChildMarkers();
      if (!childMarkers || childMarkers.length <= 1) return;

      const childPhotos: string[] = childMarkers
        .map((m: any) => m.photoPath as string)
        .filter(Boolean);

      if (childPhotos.length <= 1) return;

      // Intercept wheel on cluster so the map does NOT zoom
      e.preventDefault();
      e.stopPropagation();

      let currentIdx = (clusterMarker as any)._activePhotoIndex ?? -1;
      if (currentIdx === -1 && selectedPathRef.current) {
        currentIdx = childPhotos.indexOf(selectedPathRef.current);
      }
      if (currentIdx === -1) {
        currentIdx = 0;
      }

      const direction = e.deltaY > 0 ? 1 : -1;
      const nextIdx = (currentIdx + direction + childPhotos.length) % childPhotos.length;
      (clusterMarker as any)._activePhotoIndex = nextIdx;
      const nextPath = childPhotos[nextIdx];

      if (onRequestThumbnailsRef.current) {
        onRequestThumbnailsRef.current([nextPath]);
      }

      // Update cluster thumbnail & badge directly in DOM for instant response
      const imgEl = clusterEl.querySelector('img');
      const thumbs = useProcessStore.getState().thumbnails;
      if (imgEl && thumbs[nextPath]) {
        imgEl.src = thumbs[nextPath];
      }
      const badgeEl = clusterEl.querySelector('[data-cluster-badge]');
      if (badgeEl) {
        badgeEl.textContent = `${nextIdx + 1}/${childPhotos.length}`;
      }

      isWheelSelectingRef.current = true;
      onSelectPhotoRef.current(nextPath, new MouseEvent('click'));
      setTimeout(() => {
        isWheelSelectingRef.current = false;
      }, 150);
    };

    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true } as any);
    };
  }, [map]);

  // Attach popup click handler for reverting GPS and map contextmenu handler
  useEffect(() => {
    const handlePopupOpen = (e: L.PopupEvent) => {
      const el = e.popup.getElement();
      if (!el) return;
      const btnRevert = el.querySelector<HTMLButtonElement>('[data-action="revert-gps"]');
      if (btnRevert) {
        btnRevert.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const p = btnRevert.getAttribute('data-path');
          if (p && onRevertGpsRef.current) {
            onRevertGpsRef.current(p);
            map.closePopup();
          }
        };
      }
    };

    const handleContextMenu = (e: L.LeafletMouseEvent) => {
      if (onMapContextMenuRef.current) {
        onMapContextMenuRef.current(
          e.latlng.lat,
          ((((e.latlng.lng + 180) % 360) + 360) % 360) - 180,
          e.originalEvent.clientX,
          e.originalEvent.clientY,
        );
      }
    };

    map.on('popupopen', handlePopupOpen);
    map.on('contextmenu', handleContextMenu);
    return () => {
      map.off('popupopen', handlePopupOpen);
      map.off('contextmenu', handleContextMenu);
    };
  }, [map]);

  // Initialize marker cluster once into reactive state with controlled click behavior and photo icons
  useEffect(() => {
    const clusterGroup = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 60,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: false,
      iconCreateFunction: (c: L.MarkerCluster) => {
        const count = c.getChildCount();
        const clusterId = (c as any)._leaflet_id;
        clustersMapRef.current.set(clusterId, c);

        const childMarkers = c.getAllChildMarkers();
        const childPaths = childMarkers
          .map((m: any) => m.photoPath as string)
          .filter(Boolean);

        let activeIdx = (c as any)._activePhotoIndex;
        if (activeIdx === undefined) {
          if (selectedPathRef.current) {
            const foundIdx = childPaths.indexOf(selectedPathRef.current);
            activeIdx = foundIdx !== -1 ? foundIdx : 0;
          } else {
            activeIdx = 0;
          }
          (c as any)._activePhotoIndex = activeIdx;
        }

        const activePath = childPaths[activeIdx] || childPaths[0];

        if (!showThumbnailCardsRef.current) {
          return createCompactClusterPin(count, clusterId);
        }

        const currentThumbs = useProcessStore.getState().thumbnails;
        let cachedThumbUrl: string | null = (activePath && currentThumbs[activePath]) || null;
        if (!cachedThumbUrl) {
          for (let i = 0; i < childPaths.length; i++) {
            const p = childPaths[i];
            if (p && currentThumbs[p]) {
              cachedThumbUrl = currentThumbs[p];
              break;
            }
          }
        }

        if (cachedThumbUrl) {
          return createClusterThumbnailPin(cachedThumbUrl, count, clusterId, activeIdx);
        }

        return createClusterLoadingPin(count, clusterId, activeIdx);
      },
    });

    const handleClusterClick = (e: L.LeafletEvent) => {
      const clusterMarker = (e as any).layer as L.MarkerCluster;
      if (!clusterMarker) return;

      const bounds = clusterMarker.getBounds();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      const distance = ne.distanceTo(sw); // distance in meters across photos in cluster

      if (distance > 15 && map.getZoom() < 17) {
        map.fitBounds(bounds, { maxZoom: 17, padding: [40, 40] });
      } else {
        const childMarkers = clusterMarker.getAllChildMarkers();
        const childPaths = childMarkers.map((m: any) => m.photoPath as string).filter(Boolean);
        if (childPaths.length > 0) {
          let currIdx = (clusterMarker as any)._activePhotoIndex ?? 0;
          const nextIdx = (currIdx + 1) % childPaths.length;
          (clusterMarker as any)._activePhotoIndex = nextIdx;
          const nextPath = childPaths[nextIdx];

          const el = clusterMarker.getElement();
          if (el) {
            const imgEl = el.querySelector('img');
            const thumbs = useProcessStore.getState().thumbnails;
            if (imgEl && thumbs[nextPath]) {
              imgEl.src = thumbs[nextPath];
            }
            const badgeEl = el.querySelector('[data-cluster-badge]');
            if (badgeEl) {
              badgeEl.textContent = `${nextIdx + 1}/${childPaths.length}`;
            }
          }

          isWheelSelectingRef.current = true;
          onSelectPhotoRef.current(nextPath, new MouseEvent('click'));
          setTimeout(() => {
            isWheelSelectingRef.current = false;
          }, 150);
        }
      }
    };

    clusterGroup.on('clusterclick', handleClusterClick);

    map.addLayer(clusterGroup);
    setCluster(clusterGroup);

    return () => {
      clusterGroup.off('clusterclick', handleClusterClick);
      clusterGroup.clearLayers();
      map.removeLayer(clusterGroup);
      clustersMapRef.current.clear();
      markersMapRef.current.clear();
      setCluster(null);
    };
  }, [map]);

  // Lazy request visible thumbnails for standalone pins and cluster representatives in viewport
  const requestVisibleThumbnails = useCallback(() => {
    if (!showThumbnailCards || !onRequestThumbnails || !map || !cluster) return;

    try {
      const bounds = map.getBounds();
      const currentThumbs = useProcessStore.getState().thumbnails;
      const missing: string[] = [];
      const seenClusters = new Set<any>();

      for (const photo of photos) {
        if (missing.length >= 30) break;

        const marker = markersMapRef.current.get(photo.path);
        if (!marker) continue;

        // Check if marker coordinate is within the current viewport
        if (!bounds.contains([photo.lat, photo.lon])) continue;

        const visibleParent = cluster.getVisibleParent(marker);
        if (!visibleParent) continue;

        if (visibleParent === marker) {
          // Standalone visible pin
          if (!currentThumbs[photo.path] && !missing.includes(photo.path)) {
            missing.push(photo.path);
          }
        } else {
          // Inside a visible cluster
          if (seenClusters.has(visibleParent)) continue;
          seenClusters.add(visibleParent);

          // Check if ANY photo in this cluster already has a cached thumbnail
          const childMarkers = (visibleParent as L.MarkerCluster).getAllChildMarkers();
          const hasAnyCachedThumb = childMarkers.some((m) => {
            const p = (m as any).photoPath;
            return p && Boolean(currentThumbs[p]);
          });

          if (!hasAnyCachedThumb && childMarkers.length > 0) {
            // Request ONLY ONE photo for the whole cluster!
            const repPath = (childMarkers[0] as any)?.photoPath;
            if (repPath && !currentThumbs[repPath] && !missing.includes(repPath)) {
              missing.push(repPath);
            }
          }
        }
      }

      if (missing.length > 0) {
        onRequestThumbnails(missing);
      }
    } catch {
      // Map may not be ready or bounds invalid
    }
  }, [showThumbnailCards, onRequestThumbnails, map, cluster, photos]);

  // Listen for double click and context menu inside popup cards
  useEffect(() => {
    const container = map.getContainer();

    const handlePopupDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const popupCard = target?.closest('[data-photo-path]') as HTMLElement | null;
      if (popupCard) {
        const path = popupCard.getAttribute('data-photo-path');
        if (path) {
          e.preventDefault();
          e.stopPropagation();
          onDoubleClickPhoto(path);
        }
      }
    };

    const handlePopupContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const popupCard = target?.closest('[data-photo-path]') as HTMLElement | null;
      if (popupCard) {
        const path = popupCard.getAttribute('data-photo-path');
        if (path) {
          e.preventDefault();
          e.stopPropagation();
          onContextMenuPhoto(e, path);
        }
      }
    };

    container.addEventListener('dblclick', handlePopupDblClick, true);
    container.addEventListener('contextmenu', handlePopupContextMenu, true);

    return () => {
      container.removeEventListener('dblclick', handlePopupDblClick, true);
      container.removeEventListener('contextmenu', handlePopupContextMenu, true);
    };
  }, [map, onDoubleClickPhoto, onContextMenuPhoto]);

  // Manage markers in cluster reactivity (never out-of-sync)
  useEffect(() => {
    if (!cluster) return;

    const currentThumbs = useProcessStore.getState().thumbnails;
    const currentPaths = new Set(photos.map((p) => p.path));
    const existingMarkers = markersMapRef.current;

    // 1. Remove markers for photos that no longer exist
    const markersToRemove: L.Marker[] = [];
    existingMarkers.forEach((marker, path) => {
      if (!currentPaths.has(path)) {
        markersToRemove.push(marker);
        existingMarkers.delete(path);
      }
    });
    if (markersToRemove.length > 0) {
      cluster.removeLayers(markersToRemove);
    }

    // 2. Add markers for photos not yet inside the cluster
    const markersToAdd: L.Marker[] = [];
    photos.forEach((photo) => {
      let marker = existingMarkers.get(photo.path);

      if (!marker) {
        const isSelected = selectedPath === photo.path;
        const cachedThumb = currentThumbs[photo.path];

        const icon = !showThumbnailCards
          ? createCustomPin(isSelected, photo.isRaw)
          : cachedThumb
            ? createPhotoThumbnailPin(cachedThumb, isSelected, photo.isRaw, photo.filename)
            : createThumbnailLoadingPin(isSelected, photo.isRaw, photo.filename);

        marker = L.marker([photo.lat, photo.lon], {
          icon,
          title: photo.filename,
          draggable: true,
          autoPan: true,
        });
        (marker as any).photoPath = photo.path;

        marker.bindPopup(
          buildPopupHtml(photo, cachedThumb, dblClickHint, revertGpsText, dragHintText),
          {
            closeButton: true,
            autoPan: true,
            maxWidth: 540,
            minWidth: 440,
          },
        );

        marker.on('dragstart', () => {
          map.closePopup();
        });

        marker.on('dragend', (e: L.LeafletEvent) => {
          const target = e.target as L.Marker;
          const newLatLng = target.getLatLng();
          const lat = newLatLng.lat;
          const lon = ((((newLatLng.lng + 180) % 360) + 360) % 360) - 180;
          if (onMovePhotoRef.current) {
            onMovePhotoRef.current(photo.path, lat, lon);
          }
        });

        marker.on('click', (e: L.LeafletMouseEvent) => {
          onSelectPhoto(photo.path, e.originalEvent);
          if (!useProcessStore.getState().thumbnails[photo.path] && onRequestThumbnails) {
            onRequestThumbnails([photo.path]);
          }
        });

        marker.on('dblclick', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stop(e);
          onDoubleClickPhoto(photo.path);
        });

        marker.on('contextmenu', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stop(e);
          onContextMenuPhoto(e.originalEvent, photo.path);
        });

        existingMarkers.set(photo.path, marker);
      } else {
        (marker as any).photoPath = photo.path;
        const curLatLng = marker.getLatLng();
        if (
          Math.abs(curLatLng.lat - photo.lat) > 1e-6 ||
          Math.abs(curLatLng.lng - photo.lon) > 1e-6
        ) {
          cluster.removeLayer(marker);
          marker.setLatLng([photo.lat, photo.lon]);
          cluster.addLayer(marker);
        }
        const cachedThumb = currentThumbs[photo.path];
        marker.setPopupContent(
          buildPopupHtml(photo, cachedThumb, dblClickHint, revertGpsText, dragHintText),
        );
      }

      if (!cluster.hasLayer(marker)) {
        markersToAdd.push(marker);
      }
    });

    if (markersToAdd.length > 0) {
      cluster.addLayers(markersToAdd);
    }

    // 3. Initial view positioning (zoom directly to selected photo if present, otherwise fit bounds)
    const selectedPhoto = selectedPath ? photos.find((p) => p.path === selectedPath) : null;

    if (!hasInitialFitRef.current && photos.length > 0) {
      hasInitialFitRef.current = true;
      if (selectedPhoto) {
        hasZoomedToInitialRef.current = true;
        const targetMarker = markersMapRef.current.get(selectedPhoto.path);
        const targetZoom = 16;
        map.setView([selectedPhoto.lat, selectedPhoto.lon], targetZoom);
        if (targetMarker) {
          const visibleParent = cluster ? cluster.getVisibleParent(targetMarker) : targetMarker;
          if (!cluster || visibleParent === targetMarker) {
            targetMarker.openPopup();
          }
        }
      } else {
        try {
          const latLngs = photos.map((p) => [p.lat, p.lon] as [number, number]);
          const bounds = L.latLngBounds(latLngs);
          if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
          }
        } catch (e) {
          console.error('Failed to fit bounds', e);
        }
      }
    }
  }, [
    cluster,
    photos,
    onSelectPhoto,
    onDoubleClickPhoto,
    onContextMenuPhoto,
    onRequestThumbnails,
    map,
    dblClickHint,
    revertGpsText,
    dragHintText,
    showThumbnailCards,
  ]);

  // Debounced listener to request thumbnails only for visible standalone pins
  useEffect(() => {
    if (!showThumbnailCards || !cluster) return;

    const debouncedReq = debounce(requestVisibleThumbnails, 250);
    map.on('moveend', debouncedReq);
    map.on('zoomend', debouncedReq);
    cluster.on('animationend', debouncedReq);
    cluster.on('spiderfied', debouncedReq);

    const timer = setTimeout(requestVisibleThumbnails, 400);

    return () => {
      map.off('moveend', debouncedReq);
      map.off('zoomend', debouncedReq);
      cluster.off('animationend', debouncedReq);
      cluster.off('spiderfied', debouncedReq);
      clearTimeout(timer);
      debouncedReq.cancel();
    };
  }, [map, cluster, showThumbnailCards, requestVisibleThumbnails]);

  // Update individual markers and clusters that receive a new thumbnail (O(1) per arriving thumb)
  useEffect(() => {
    if (!showThumbnailCards) return;

    const newlyAdded: string[] = [];
    for (const path in thumbnails) {
      if (!prevThumbnailsKeysRef.current.has(path)) {
        prevThumbnailsKeysRef.current.add(path);
        newlyAdded.push(path);
      }
    }

    if (newlyAdded.length === 0) return;

    const markersToRefresh: L.Marker[] = [];
    for (const path of newlyAdded) {
      const marker = markersMapRef.current.get(path);
      const photo = photos.find((p) => p.path === path);
      if (marker && photo) {
        const thumbUrl = thumbnails[path];
        const isSelected = selectedPath === path;
        marker.setIcon(createPhotoThumbnailPin(thumbUrl, isSelected, photo.isRaw, photo.filename));
        marker.setPopupContent(
          buildPopupHtml(photo, thumbUrl, dblClickHint, revertGpsText, dragHintText),
        );
        markersToRefresh.push(marker);
      }
    }

    if (cluster && markersToRefresh.length > 0) {
      try {
        cluster.refreshClusters(markersToRefresh);
      } catch {
        cluster.refreshClusters();
      }
    }
  }, [
    thumbnails,
    showThumbnailCards,
    photos,
    selectedPath,
    dblClickHint,
    revertGpsText,
    dragHintText,
    cluster,
  ]);

  // Toggle between Compact Pins and Thumbnail Cards without rebuilding cluster
  useEffect(() => {
    markersMapRef.current.forEach((marker, path) => {
      const photo = photos.find((p) => p.path === path);
      if (!photo) return;

      const isSelected = selectedPath === path;
      if (!showThumbnailCards) {
        marker.setIcon(createCustomPin(isSelected, photo.isRaw));
      } else {
        const thumb = thumbnails[path];
        marker.setIcon(
          thumb
            ? createPhotoThumbnailPin(thumb, isSelected, photo.isRaw, photo.filename)
            : createThumbnailLoadingPin(isSelected, photo.isRaw, photo.filename),
        );
      }
    });

    if (cluster) {
      cluster.refreshClusters();
    }
  }, [showThumbnailCards, photos, selectedPath, thumbnails, cluster]);

  // Highlight and smooth flyTo selected photo
  useEffect(() => {
    // Un-highlight previous
    if (prevSelectedPathRef.current && prevSelectedPathRef.current !== selectedPath) {
      const prevMarker = markersMapRef.current.get(prevSelectedPathRef.current);
      const prevPhoto = photos.find((p) => p.path === prevSelectedPathRef.current);
      if (prevMarker && prevPhoto) {
        const thumb = thumbnails[prevSelectedPathRef.current];
        prevMarker.setIcon(
          showThumbnailCards && thumb
            ? createPhotoThumbnailPin(thumb, false, prevPhoto.isRaw, prevPhoto.filename)
            : showThumbnailCards
              ? createThumbnailLoadingPin(false, prevPhoto.isRaw, prevPhoto.filename)
              : createCustomPin(false, prevPhoto.isRaw),
        );
      }
    }

    const isDifferent = prevSelectedPathRef.current !== selectedPath;
    prevSelectedPathRef.current = selectedPath;

    if (!selectedPath) return;

    // If selection was triggered by mouse wheel cycling inside a cluster, do not fly or spiderfy
    if (isWheelSelectingRef.current) return;

    const marker = markersMapRef.current.get(selectedPath);
    const photo = photos.find((p) => p.path === selectedPath);

    if (marker && photo) {
      const thumb = thumbnails[selectedPath];
      marker.setIcon(
        showThumbnailCards && thumb
          ? createPhotoThumbnailPin(thumb, true, photo.isRaw, photo.filename)
          : showThumbnailCards
            ? createThumbnailLoadingPin(true, photo.isRaw, photo.filename)
            : createCustomPin(true, photo.isRaw),
      );

      const targetZoom = Math.max(map.getZoom(), 16);

      if (!hasZoomedToInitialRef.current || isDifferent) {
        hasZoomedToInitialRef.current = true;
        const visibleParent = cluster ? cluster.getVisibleParent(marker) : marker;
        if (!cluster || visibleParent === marker) {
          marker.openPopup();
          if (map.getZoom() < targetZoom) {
            map.flyTo([photo.lat, photo.lon], targetZoom, { duration: 0.5 });
          }
        } else if (visibleParent) {
          const clusterObj = visibleParent as L.MarkerCluster;
          const childMarkers = clusterObj.getAllChildMarkers();
          const childPaths = childMarkers
            .map((m: any) => m.photoPath as string)
            .filter(Boolean);
          const idx = childPaths.indexOf(photo.path);
          if (idx !== -1) {
            (clusterObj as any)._activePhotoIndex = idx;
            const el = clusterObj.getElement();
            if (el) {
              const imgEl = el.querySelector('img');
              if (imgEl && thumb) {
                imgEl.src = thumb;
              }
              const badgeEl = el.querySelector('[data-cluster-badge]');
              if (badgeEl) {
                badgeEl.textContent = `${idx + 1}/${childPaths.length}`;
              }
            }
          }
          map.panTo([photo.lat, photo.lon], { animate: true, duration: 0.4 });
        }
      }
    }
  }, [selectedPath, photos, map, showThumbnailCards, thumbnails, cluster]);

  return null;
};

interface UnlocatedPhotoCardProps {
  photo: ImageFile;
  filename: string;
  timestamp: string | null;
  exif?: Record<string, string>;
  thumbUrl?: string;
  isSelected: boolean;
  cardHeight: number;
  onSelect: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onRequestThumb: (path: string) => void;
}

const UnlocatedPhotoCard: React.FC<UnlocatedPhotoCardProps> = React.memo(
  ({
    photo,
    filename,
    timestamp,
    exif,
    thumbUrl,
    isSelected,
    cardHeight,
    onSelect,
    onDoubleClick,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onRequestThumb,
  }) => {
    useEffect(() => {
      if (!thumbUrl) {
        onRequestThumb(photo.path);
      }
    }, [photo.path, thumbUrl, onRequestThumb]);

    const { shutter, fNumber, iso, focal } = useMemo(() => {
      const e = exif || photo.exif || {};
      let fNum = e.FNumber ? String(e.FNumber) : '';
      if (fNum && !fNum.toLowerCase().startsWith('f')) fNum = `f/${fNum}`;
      const focalVal = e.FocalLengthIn35mmFilm || e.FocalLength || '';
      const focalStr = focalVal
        ? String(focalVal).endsWith('mm')
          ? String(focalVal)
          : `${focalVal}mm`
        : '';
      return {
        shutter: e.ExposureTime || '',
        fNumber: fNum,
        iso: e.PhotographicSensitivity || e.ISOSpeedRatings || '',
        focal: focalStr,
      };
    }, [exif, photo.exif]);

    return (
      <div
        draggable={true}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        style={{ width: '100%', height: cardHeight }}
        className={clsx(
          'shrink-0 bg-surface rounded-md overflow-hidden cursor-pointer active:cursor-grabbing group relative flex flex-col transition-shadow duration-150 shadow-sm hover:shadow-md select-none',
          isSelected && 'ring-2 ring-accent z-10 shadow-md',
        )}
      >
        {/* Full Image Container with object-contain so the entire photo is shown without cropping */}
        <div className="relative w-full flex-1 min-h-0 z-0 bg-surface">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={filename}
              className="w-full h-full object-contain relative group-hover:scale-[1.02] select-none pointer-events-none"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-surface">
              <ImageIcon className="text-text-secondary animate-pulse" />
            </div>
          )}
        </div>

        {/* Gradient shadow behind title */}
        <div className="absolute bottom-0 left-0 right-0 h-16 transition-opacity duration-300 pointer-events-none z-10 bg-linear-to-t from-black/75 to-transparent group-hover:opacity-0" />

        {/* Bottom bar with title and shooting data on hover */}
        <div className="absolute bottom-0 left-0 right-0 flex flex-col p-2 pb-1.5 transition-all duration-300 ease-in-out z-20 bg-transparent group-hover:bg-surface/85 backdrop-blur-none group-hover:backdrop-blur-md border-t border-transparent group-hover:border-border-color/50">
          <div className="flex items-end justify-between shrink-0">
            <span
              className="truncate pr-2 text-xs font-medium text-white transition-colors duration-300"
              title={filename}
            >
              {filename}
            </span>
          </div>

          <div className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out shrink-0 grid-rows-[0fr] opacity-0 group-hover:grid-rows-[1fr] group-hover:opacity-100">
            <div className="overflow-hidden min-h-0">
              <div className="pt-1.5 pb-0.5 flex flex-wrap items-center gap-x-2.5 shrink-0 text-text-secondary">
                {shutter && (
                  <div className="flex items-center gap-1">
                    <IconShutter className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">
                      {shutter}
                    </span>
                  </div>
                )}
                {fNumber && (
                  <div className="flex items-center gap-1">
                    <IconAperture className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">
                      {fNumber}
                    </span>
                  </div>
                )}
                {iso && (
                  <div className="flex items-center gap-1">
                    <IconIso className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">
                      {iso}
                    </span>
                  </div>
                )}
                {focal && (
                  <div className="flex items-center gap-1">
                    <IconFocalLength className="w-2.5 h-2.5 text-text-secondary shrink-0" />
                    <span className="text-[9px] font-medium tracking-wide text-text-primary">
                      {focal}
                    </span>
                  </div>
                )}
                {!shutter && !fNumber && !iso && !focal && timestamp && (
                  <span className="text-[9px] font-medium tracking-wide text-text-secondary">
                    {timestamp}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Selection / Hover ring */}
        <div
          className={clsx(
            'absolute inset-0 rounded-md pointer-events-none z-30 transition-all duration-150 ring-2 ring-inset',
            isSelected ? 'ring-accent' : 'ring-transparent group-hover:ring-hover-color',
          )}
        />
      </div>
    );
  },
);

interface MapControlsProps {
  onFitBounds: () => void;
  tileStyle: MapStyle;
  onTileStyleChange: (style: MapStyle) => void;
  showThumbnailCards: boolean;
  onToggleThumbnailCards: () => void;
  isDockOpen: boolean;
  onToggleDock: () => void;
  unlocatedCount: number;
  canUndo?: boolean;
  onUndo?: () => void;
}

const MapControls: React.FC<MapControlsProps> = ({
  onFitBounds,
  tileStyle,
  onTileStyleChange,
  showThumbnailCards,
  onToggleThumbnailCards,
  isDockOpen,
  onToggleDock,
  unlocatedCount,
  canUndo,
  onUndo,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
      {/* Toggle Unlocated Photos Dock */}
      <button
        onClick={onToggleDock}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 relative ${
          isDockOpen
            ? 'bg-accent/20 border-accent text-accent shadow-accent/20'
            : 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-secondary hover:text-text-primary'
        }`}
        title={t('library.map.toggleDock', {
          defaultValue: 'Unlocated photos panel',
        })}
      >
        <MapPinOff className="w-4 h-4" />
        {unlocatedCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-black text-[9px] font-black px-1.5 py-0.2 rounded-full leading-tight shadow-md">
            {unlocatedCount > 99 ? '99+' : unlocatedCount}
          </span>
        )}
      </button>

      {/* Undo Button */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 ${
          canUndo
            ? 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-primary hover:text-accent cursor-pointer'
            : 'bg-surface/50 border-border-color/20 text-text-secondary/40 cursor-not-allowed opacity-50'
        }`}
        title={
          canUndo
            ? t('library.map.undoTooltip', { defaultValue: 'Undo GPS change (Ctrl+Z)' })
            : t('library.map.undoDisabled', { defaultValue: 'No GPS changes to undo' })
        }
      >
        <Undo2 className="w-4 h-4" />
      </button>

      <button
        onClick={onFitBounds}
        className="w-9 h-9 rounded-lg bg-surface/90 hover:bg-surface border border-border-color/30 text-text-secondary hover:text-text-primary flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95"
        title={t('library.map.fitBounds', { defaultValue: 'Fit all photos in view' })}
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      {/* Toggle Thumbnails Card vs Compact Pin */}
      <button
        onClick={onToggleThumbnailCards}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 ${
          showThumbnailCards
            ? 'bg-accent/20 border-accent text-accent shadow-accent/20'
            : 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-secondary hover:text-text-primary'
        }`}
        title={
          showThumbnailCards
            ? t('library.map.cardsActive', {
                defaultValue: 'Photo thumbnail cards active (click for compact pins)',
              })
            : t('library.map.pinsActive', { defaultValue: 'Compact pins active (click for photo cards)' })
        }
      >
        <ImageIcon className="w-4 h-4" />
      </button>

      {/* Basemap Selection */}
      <div className="relative">
        <button
          onClick={() => setShowMenu((prev) => !prev)}
          className={`w-9 h-9 rounded-lg border flex items-center justify-center shadow-lg backdrop-blur-sm transition active:scale-95 ${
            showMenu
              ? 'bg-accent border-accent text-button-text'
              : 'bg-surface/90 hover:bg-surface border-border-color/30 text-text-secondary hover:text-text-primary'
          }`}
          title={t('library.map.styleSelector', { defaultValue: 'Select map style' })}
        >
          <Layers className="w-4 h-4" />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-11 w-44 bg-surface/95 border border-border-color/40 rounded-xl shadow-2xl p-1.5 flex flex-col gap-1 backdrop-blur-md z-[1001]">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary px-2 py-1">
              {t('library.map.mapStyle', { defaultValue: 'Map Style' })}
            </span>
            {(Object.values(MAP_LAYERS) as MapLayerConfig[]).map((layer) => (
              <button
                key={layer.id}
                onClick={() => {
                  onTileStyleChange(layer.id);
                  setShowMenu(false);
                }}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition text-left ${
                  tileStyle === layer.id
                    ? 'bg-accent/20 text-accent border border-accent/40 font-medium'
                    : 'text-text-primary hover:bg-hover-color border border-transparent'
                }`}
              >
                <span>{layer.icon}</span>
                <span>{layer.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export interface MapViewProps {
  imageList: Array<ImageFile>;
  activePath: string | null;
  multiSelectedPaths: Array<string>;
  currentFolderPath?: string | null;
  onImageClick(path: string, event: React.MouseEvent | MouseEvent): void;
  onImageDoubleClick(path: string): void;
  onContextMenu(event: React.MouseEvent | MouseEvent, path: string): void;
  onEmptyAreaContextMenu?(event: React.MouseEvent | MouseEvent): void;
  onRequestThumbnails?(paths: string[]): void;
}

interface GpsUndoItem {
  path: string;
  previousLat: number | null;
  previousLon: number | null;
  hadNativeGps?: boolean;
}

interface GpsUndoAction {
  items: GpsUndoItem[];
}

export default function MapView(props: MapViewProps) {
  const [tileStyle, setTileStyle] = useState<MapStyle>(getInitialMapStyle);
  const [showThumbnailCards, setShowThumbnailCards] = useState<boolean>(getInitialShowThumbnails);
  const [isDockOpen, setIsDockOpen] = useState<boolean>(getInitialDockOpen);
  const [dockWidth, setDockWidth] = useState<number>(getInitialDockWidth);
  const [selectedDockPaths, setSelectedDockPaths] = useState<Set<string>>(new Set());
  const [isDraggingOverMap, setIsDraggingOverMap] = useState<boolean>(false);
  const [mapContextMenu, setMapContextMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lon: number;
    targetPaths: string[];
  } | null>(null);

  const [localExifMap, setLocalExifMap] = useState<Record<string, Record<string, string>>>({});
  const requestedExifRef = useRef<Set<string>>(new Set());
  const mapRef = useRef<L.Map | null>(null);
  const isResizing = useRef(false);
  const [isResizingState, setIsResizingState] = useState(false);
  const dockWidthRef = useRef(dockWidth);

  const undoStackRef = useRef<GpsUndoAction[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    dockWidthRef.current = dockWidth;
  }, [dockWidth]);
  const thumbnails = useProcessStore((s) => s.thumbnails);
  const mediumThumbnails = useProcessStore((s) => s.mediumThumbnails);
  const { t } = useTranslation();

  const handleTileStyleChange = useCallback((style: MapStyle) => {
    setTileStyle(style);
    try {
      localStorage.setItem(MAP_STYLE_STORAGE_KEY, style);
    } catch (e) {
      console.error('Failed to save map style to localStorage', e);
    }
  }, []);

  const handleToggleThumbnailCards = useCallback(() => {
    setShowThumbnailCards((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MAP_SHOW_THUMBNAILS_STORAGE_KEY, String(next));
      } catch (e) {
        console.error('Failed to save show thumbnails setting to localStorage', e);
      }
      return next;
    });
  }, []);

  const handleToggleDock = useCallback(() => {
    setIsDockOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MAP_DOCK_OPEN_STORAGE_KEY, String(next));
      } catch (e) {
        console.error('Failed to save dock open setting to localStorage', e);
      }
      return next;
    });
  }, []);

  // Invalidate Leaflet size whenever dock width or open state changes
  useEffect(() => {
    const timer = setTimeout(() => {
      mapRef.current?.invalidateSize();
    }, 220);
    return () => clearTimeout(timer);
  }, [isDockOpen, dockWidth]);

  // Dock Resizing Handlers
  const resize = useCallback((mouseMoveEvent: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - mouseMoveEvent.clientX;
    if (newWidth >= 160 && newWidth <= 550) {
      dockWidthRef.current = newWidth;
      setDockWidth(newWidth);
    }
  }, []);

  const stopResizing = useCallback(() => {
    if (!isResizing.current) return;
    isResizing.current = false;
    setIsResizingState(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResizing);
    try {
      localStorage.setItem(MAP_DOCK_WIDTH_STORAGE_KEY, String(dockWidthRef.current));
    } catch (e) {
      console.error('Failed to save dock width to localStorage', e);
    }
    mapRef.current?.invalidateSize();
  }, [resize]);

  const startResizing = useCallback(
    (mouseDownEvent: React.MouseEvent) => {
      mouseDownEvent.preventDefault();
      isResizing.current = true;
      setIsResizingState(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', stopResizing);
    },
    [resize, stopResizing],
  );

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', resize);
      document.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  // Close context menu on outside click
  useEffect(() => {
    const handleWindowClick = () => setMapContextMenu(null);
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, []);

  const {
    imageList,
    activePath,
    multiSelectedPaths,
    currentFolderPath,
    onImageClick,
    onImageDoubleClick,
    onContextMenu,
    onRequestThumbnails,
  } = props;

  const editorSelectedPath = useEditorStore((s) => s.selectedImage?.path);
  const libraryActivePath = useLibraryStore((s) => s.libraryActivePath);

  const effectiveSelectedPath = useMemo(() => {
    return (
      activePath ||
      libraryActivePath ||
      editorSelectedPath ||
      (multiSelectedPaths && multiSelectedPaths.length > 0 ? multiSelectedPaths[0] : null) ||
      null
    );
  }, [activePath, libraryActivePath, editorSelectedPath, multiSelectedPaths]);

  // Thumbnail batch queue
  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<any>(null);

  const queueThumbnailRequest = useCallback(
    (path: string) => {
      if (!onRequestThumbnails) return;
      if (useProcessStore.getState().thumbnails[path]) return;
      requestQueueRef.current.add(path);
      if (!requestTimeoutRef.current) {
        requestTimeoutRef.current = setTimeout(() => {
          const paths = Array.from(requestQueueRef.current);
          if (paths.length > 0) {
            onRequestThumbnails(paths);
            requestQueueRef.current.clear();
          }
          requestTimeoutRef.current = null;
        }, 50);
      }
    },
    [onRequestThumbnails],
  );

  // Reset EXIF request tracking and undo stack when switching folders
  useEffect(() => {
    requestedExifRef.current.clear();
    setLocalExifMap({});
    setSelectedDockPaths(new Set());
    setMapContextMenu(null);
    undoStackRef.current = [];
    setCanUndo(false);
  }, [currentFolderPath]);

  // Non-blocking, smooth EXIF ingestion without continuous UI re-sorting loops
  useEffect(() => {
    const unrequested = imageList.filter(
      (img) => !img.exif && !localExifMap[img.path] && !requestedExifRef.current.has(img.path),
    );
    if (unrequested.length === 0) return;

    unrequested.forEach((img) => requestedExifRef.current.add(img.path));

    let isCancelled = false;
    const loadExif = async () => {
      const chunkSize = 100;
      const accumulatedUpdates: Record<string, Record<string, string>> = {};

      for (let i = 0; i < unrequested.length; i += chunkSize) {
        if (isCancelled) break;
        const chunk = unrequested.slice(i, i + chunkSize).map((img) => img.path);
        try {
          const chunkExif = await invoke<Record<string, Record<string, string>>>(
            Invokes.ReadExifForPaths,
            { paths: chunk },
          );
          if (isCancelled) break;

          setLocalExifMap((prev) => ({ ...prev, ...chunkExif }));
          Object.assign(accumulatedUpdates, chunkExif);
        } catch (err) {
          console.error('Failed to read EXIF for MapView:', err);
        }
      }

      if (!isCancelled && Object.keys(accumulatedUpdates).length > 0) {
        useLibraryStore.getState().setLibrary((state) => ({
          imageList: state.imageList.map((img) =>
            accumulatedUpdates[img.path] ? { ...img, exif: accumulatedUpdates[img.path] } : img,
          ),
        }));
      }
    };

    loadExif();
    return () => {
      isCancelled = true;
    };
  }, [imageList.length, currentFolderPath]);

  // Compute Geotagged and Unlocated photos
  const { geotaggedPhotos, unlocatedPhotos, totalPhotos, geotaggedCount } = useMemo(() => {
    const items: MapPhotoItem[] = [];
    const unlocated: ImageFile[] = [];

    for (const img of imageList) {
      const exifOverride = localExifMap[img.path];
      const gps: GeoLocation | null = getImageGps(img, exifOverride);
      if (gps) {
        const filename = img.path.split(/[\\/]/).pop() || '';
        const timestamp = getImageTimestamp(img, exifOverride);
        const hasNative =
          exifOverride?.HasNativeGPS === 'true' ||
          img.exif?.HasNativeGPS === 'true';
        const isModified =
          exifOverride?.IsGpsModified === 'true' ||
          img.exif?.IsGpsModified === 'true';

        items.push({
          id: img.path,
          path: img.path,
          filename,
          lat: gps.lat,
          lon: gps.lon,
          timestamp,
          isRaw: img.is_raw,
          image: img,
          hasNativeGps: hasNative,
          isGpsModified: isModified,
        });
      } else {
        unlocated.push(img);
      }
    }
    return {
      geotaggedPhotos: items,
      unlocatedPhotos: unlocated,
      totalPhotos: imageList.length,
      geotaggedCount: items.length,
    };
  }, [imageList, localExifMap]);

  // Apply or remove GPS coordinates to sidecars and state, with optional Undo tracking
  const applyGpsToPhotosInternal = useCallback(
    async (
      paths: string[],
      lat: number | null,
      lon: number | null,
      recordUndo: boolean = true,
      customSuccessMsg?: string,
    ) => {
      if (paths.length === 0) return;

      // If recordUndo is true, capture previous state before changing
      if (recordUndo) {
        const undoItems: GpsUndoItem[] = [];
        for (const p of paths) {
          const img = imageList.find((i) => i.path === p);
          const currentGps = getImageGps(img, localExifMap[p]);
          const hadNative =
            localExifMap[p]?.HasNativeGPS === 'true' ||
            img?.exif?.HasNativeGPS === 'true';
          undoItems.push({
            path: p,
            previousLat: currentGps ? currentGps.lat : null,
            previousLon: currentGps ? currentGps.lon : null,
            hadNativeGps: hadNative,
          });
        }
        undoStackRef.current.push({ items: undoItems });
        setCanUndo(true);
      }

      try {
        await invoke(Invokes.SetGpsForPaths, {
          paths,
          latitude: lat,
          longitude: lon,
        });

        const updates: Record<string, string> = {};
        if (lat !== null && lon !== null) {
          updates.GPSLatitude = toDmsString(lat);
          updates.GPSLatitudeRef = lat >= 0 ? 'N' : 'S';
          updates.GPSLongitude = toDmsString(lon);
          updates.GPSLongitudeRef = lon >= 0 ? 'E' : 'W';
        }

        // 1. Immediately update local map view state so pins appear or vanish smoothly
        setLocalExifMap((prev) => {
          const next = { ...prev };
          for (const p of paths) {
            if (lat !== null && lon !== null) {
              const currentExif = next[p] || {};
              const hasNative =
                currentExif.HasNativeGPS === 'true' ||
                imageList.find((i) => i.path === p)?.exif?.HasNativeGPS === 'true';
              const modUpdate: Record<string, string> = hasNative
                ? { IsGpsModified: 'true' }
                : {};
              next[p] = { ...currentExif, ...updates, ...modUpdate };
            } else if (next[p]) {
              const cleaned = { ...next[p] };
              delete cleaned.GPSLatitude;
              delete cleaned.GPSLatitudeRef;
              delete cleaned.GPSLongitude;
              delete cleaned.GPSLongitudeRef;
              delete cleaned.IsGpsModified;
              next[p] = cleaned;
            }
          }
          return next;
        });

        // 2. Remove geotagged photos from dock selection
        setSelectedDockPaths((prev) => {
          const next = new Set(prev);
          paths.forEach((p) => next.delete(p));
          return next;
        });

        // 3. Update library store imageList
        const pathsSet = new Set(paths.map((p) => p.split('?vc=')[0]));
        useLibraryStore.getState().setLibrary((state) => ({
          imageList: state.imageList.map((img) => {
            if (pathsSet.has(img.path.split('?vc=')[0])) {
              if (lat !== null && lon !== null) {
                const hasNative =
                  img.exif?.HasNativeGPS === 'true' ||
                  localExifMap[img.path]?.HasNativeGPS === 'true';
                const modUpdate = hasNative ? { IsGpsModified: 'true' } : {};
                return { ...img, exif: { ...(img.exif || {}), ...updates, ...modUpdate } };
              } else if (img.exif) {
                const cleaned = { ...img.exif };
                delete cleaned.GPSLatitude;
                delete cleaned.GPSLatitudeRef;
                delete cleaned.GPSLongitude;
                delete cleaned.GPSLongitudeRef;
                delete cleaned.IsGpsModified;
                return { ...img, exif: cleaned };
              }
            }
            return img;
          }),
        }));

        // 4. Update editor store if current image matches
        useEditorStore.getState().setEditor((state) => {
          if (!state.selectedImage || !pathsSet.has(state.selectedImage.path.split('?vc=')[0])) {
            return state;
          }
          if (lat !== null && lon !== null) {
            const hasNative =
              state.selectedImage.exif?.HasNativeGPS === 'true' ||
              localExifMap[state.selectedImage.path]?.HasNativeGPS === 'true';
            const modUpdate = hasNative ? { IsGpsModified: 'true' } : {};
            return {
              selectedImage: {
                ...state.selectedImage,
                exif: { ...(state.selectedImage.exif || {}), ...updates, ...modUpdate },
              },
            };
          } else if (state.selectedImage.exif) {
            const cleaned = { ...state.selectedImage.exif };
            delete cleaned.GPSLatitude;
            delete cleaned.GPSLatitudeRef;
            delete cleaned.GPSLongitude;
            delete cleaned.GPSLongitudeRef;
            delete cleaned.IsGpsModified;
            return { selectedImage: { ...state.selectedImage, exif: cleaned } };
          }
          return state;
        });

        if (customSuccessMsg) {
          toast.success(customSuccessMsg);
        } else if (lat !== null) {
          const hadPreviousGps = paths.some((p) => {
            const img = imageList.find((i) => i.path === p);
            return Boolean(getImageGps(img, localExifMap[p]));
          });

          if (hadPreviousGps) {
            toast.success(
              t('library.map.repositionedSuccess', {
                count: paths.length,
                defaultValue:
                  paths.length === 1
                    ? 'Photo repositioned successfully'
                    : `${paths.length} photos repositioned successfully`,
              }),
            );
          } else {
            toast.success(
              t('library.map.geotagSuccess', {
                count: paths.length,
                defaultValue:
                  paths.length === 1
                    ? 'Photo geotagged successfully'
                    : `Successfully geotagged ${paths.length} photos`,
              }),
            );
          }
        } else {
          toast.info(
            t('library.map.geotagRemoved', {
              count: paths.length,
              defaultValue:
                paths.length === 1
                  ? 'GPS coordinates removed'
                  : `GPS coordinates removed for ${paths.length} photos`,
            }),
          );
        }
      } catch (err) {
        console.error('Failed to set GPS coordinates', err);
        toast.error(
          t('library.map.errorSavingGps', {
            defaultValue: `Error saving GPS coordinates: ${err}`,
            err: String(err),
          }),
        );
      }
    },
    [t, imageList, localExifMap],
  );

  const applyGpsToPhotos = useCallback(
    (paths: string[], lat: number | null, lon: number | null) => {
      return applyGpsToPhotosInternal(paths, lat, lon, true);
    },
    [applyGpsToPhotosInternal],
  );

  // Undo last GPS change
  const handleUndoGps = useCallback(async () => {
    const action = undoStackRef.current.pop();
    setCanUndo(undoStackRef.current.length > 0);
    if (!action || action.items.length === 0) return;

    // Group items by target previous coordinate to run in minimal batch operations
    const groups = new Map<string, { lat: number | null; lon: number | null; paths: string[] }>();
    for (const item of action.items) {
      const key = `${item.previousLat}_${item.previousLon}`;
      if (!groups.has(key)) {
        groups.set(key, { lat: item.previousLat, lon: item.previousLon, paths: [] });
      }
      groups.get(key)!.paths.push(item.path);
    }

    for (const group of groups.values()) {
      await applyGpsToPhotosInternal(group.paths, group.lat, group.lon, false);
    }

    toast.info(t('library.map.undoSuccess', { defaultValue: 'GPS change undone' }));
  }, [applyGpsToPhotosInternal, t]);

  // Global Ctrl+Z / Cmd+Z shortcut listener for undoing geotagging actions
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (undoStackRef.current.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          handleUndoGps();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndoGps]);

  // Handle reverting GPS coordinates to original camera EXIF or clearing if none existed originally
  const handleRevertGps = useCallback(
    async (path: string) => {
      // Record undo state before reverting
      const img = imageList.find((i) => i.path === path);
      const currentGps = getImageGps(img, localExifMap[path]);
      if (currentGps) {
        undoStackRef.current.push({
          items: [
            {
              path,
              previousLat: currentGps.lat,
              previousLon: currentGps.lon,
              hadNativeGps:
                localExifMap[path]?.HasNativeGPS === 'true' ||
                img?.exif?.HasNativeGPS === 'true',
            },
          ],
        });
        setCanUndo(true);
      }

      try {
        const result = await invoke<Record<string, [number, number] | null>>(
          Invokes.RevertGpsForPaths,
          { paths: [path] },
        );
        const coords = result[path];
        const cleanPath = path.split('?vc=')[0];

        if (coords) {
          // Photo originally had camera GPS: restore it
          const [lat, lon] = coords;
          const updates: Record<string, string> = {
            GPSLatitude: toDmsString(lat),
            GPSLatitudeRef: lat >= 0 ? 'N' : 'S',
            GPSLongitude: toDmsString(lon),
            GPSLongitudeRef: lon >= 0 ? 'E' : 'W',
            HasNativeGPS: 'true',
          };

          setLocalExifMap((prev) => {
            const next = { ...prev };
            const current = next[path] ? { ...next[path] } : {};
            delete current.IsGpsModified;
            next[path] = { ...current, ...updates };
            return next;
          });

          useLibraryStore.getState().setLibrary((state) => ({
            imageList: state.imageList.map((img) => {
              if (img.path.split('?vc=')[0] === cleanPath) {
                const currentExif = img.exif ? { ...img.exif } : {};
                delete currentExif.IsGpsModified;
                return { ...img, exif: { ...currentExif, ...updates } };
              }
              return img;
            }),
          }));

          useEditorStore.getState().setEditor((state) => {
            if (!state.selectedImage || state.selectedImage.path.split('?vc=')[0] !== cleanPath) {
              return state;
            }
            const currentExif = state.selectedImage.exif ? { ...state.selectedImage.exif } : {};
            delete currentExif.IsGpsModified;
            return {
              selectedImage: {
                ...state.selectedImage,
                exif: { ...currentExif, ...updates },
              },
            };
          });

          toast.success(
            t('library.map.revertSuccess', {
              count: 1,
              defaultValue: 'Restored original camera GPS coordinates for 1 photo',
            }),
          );
        } else {
          // Photo originally had NO GPS coordinates: clear from map back to dock
          setLocalExifMap((prev) => {
            const next = { ...prev };
            if (next[path]) {
              const cleaned = { ...next[path] };
              delete cleaned.GPSLatitude;
              delete cleaned.GPSLatitudeRef;
              delete cleaned.GPSLongitude;
              delete cleaned.GPSLongitudeRef;
              delete cleaned.IsGpsModified;
              next[path] = cleaned;
            }
            return next;
          });

          useLibraryStore.getState().setLibrary((state) => ({
            imageList: state.imageList.map((img) => {
              if (img.path.split('?vc=')[0] === cleanPath && img.exif) {
                const cleaned = { ...img.exif };
                delete cleaned.GPSLatitude;
                delete cleaned.GPSLatitudeRef;
                delete cleaned.GPSLongitude;
                delete cleaned.GPSLongitudeRef;
                delete cleaned.IsGpsModified;
                return { ...img, exif: cleaned };
              }
              return img;
            }),
          }));

          useEditorStore.getState().setEditor((state) => {
            if (!state.selectedImage || state.selectedImage.path.split('?vc=')[0] !== cleanPath) {
              return state;
            }
            if (state.selectedImage.exif) {
              const cleaned = { ...state.selectedImage.exif };
              delete cleaned.GPSLatitude;
              delete cleaned.GPSLatitudeRef;
              delete cleaned.GPSLongitude;
              delete cleaned.GPSLongitudeRef;
              delete cleaned.IsGpsModified;
              return { selectedImage: { ...state.selectedImage, exif: cleaned } };
            }
            return state;
          });

          toast.info(
            t('library.map.revertCleared', {
              defaultValue: 'Cleared GPS coordinates (no original camera GPS)',
            }),
          );
        }
      } catch (err) {
        console.error('Failed to revert GPS coordinates', err);
        toast.error(
          t('library.map.errorSavingGps', {
            defaultValue: `Error saving GPS coordinates: ${err}`,
            err: String(err),
          }),
        );
      }
    },
    [t, imageList, localExifMap],
  );

  // Handle moving / dragging an existing photo pin on the map
  const handleMovePhoto = useCallback(
    async (draggedPath: string, lat: number, lon: number) => {
      let targetPaths = [draggedPath];
      if (multiSelectedPaths.length > 1 && multiSelectedPaths.includes(draggedPath)) {
        targetPaths = multiSelectedPaths;
      }
      await applyGpsToPhotos(targetPaths, lat, lon);
    },
    [multiSelectedPaths, applyGpsToPhotos],
  );

  // Handle Drop on Leaflet Map
  const handleMapDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingOverMap(false);
      if (!mapRef.current) return;

      try {
        const rawData =
          e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain');
        if (!rawData) return;
        const parsed = JSON.parse(rawData);
        const pathsToGeotag: string[] = Array.isArray(parsed?.paths) ? parsed.paths : [];
        if (pathsToGeotag.length === 0) return;

        const container = mapRef.current.getContainer();
        const rect = container.getBoundingClientRect();
        const point = L.point(e.clientX - rect.left, e.clientY - rect.top);
        const latLng = mapRef.current.containerPointToLatLng(point);

        const lat = latLng.lat;
        let lon = ((((latLng.lng + 180) % 360) + 360) % 360) - 180;

        await applyGpsToPhotos(pathsToGeotag, lat, lon);

        // Smoothly pan map to drop location
        mapRef.current.panTo([lat, lon], { animate: true, duration: 0.4 });

        // Update active selection to the placed photo
        if (pathsToGeotag.length > 0) {
          onImageClick?.(pathsToGeotag[0], e as any);
        }
      } catch (err) {
        console.error('Failed to handle drop on map', err);
      }
    },
    [applyGpsToPhotos, onImageClick],
  );

  // Handle right-click on map to position selected photos
  const handleMapRightClick = useCallback(
    (lat: number, lon: number, screenX: number, screenY: number) => {
      const targetPaths =
        selectedDockPaths.size > 0
          ? Array.from(selectedDockPaths)
          : multiSelectedPaths.length > 0
            ? multiSelectedPaths
            : effectiveSelectedPath
              ? [effectiveSelectedPath]
              : [];

      if (targetPaths.length > 0) {
        setMapContextMenu({
          x: screenX,
          y: screenY,
          lat,
          lon,
          targetPaths,
        });
      }
    },
    [selectedDockPaths, multiSelectedPaths, effectiveSelectedPath],
  );

  // Cancel drag or context menu on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDraggingOverMap(false);
        setMapContextMenu(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Photo selection in dock - updates dock selection and syncs Information module
  const handlePhotoSelect = useCallback(
    (path: string, e: React.MouseEvent) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        setSelectedDockPaths((prev) => {
          const next = new Set(prev);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        });
      } else {
        setSelectedDockPaths(new Set([path]));
      }
      onImageClick?.(path, e);
    },
    [onImageClick],
  );

  // Photo drag start from dock
  const handlePhotoDragStart = useCallback(
    (photo: ImageFile, e: React.DragEvent) => {
      const pathsToDrag =
        selectedDockPaths.has(photo.path) && selectedDockPaths.size > 1
          ? Array.from(selectedDockPaths)
          : [photo.path];

      // Ensure active photo is selected in dock and synchronized with Information panel
      setSelectedDockPaths(new Set(pathsToDrag));
      onImageClick?.(photo.path, e as any);

      e.dataTransfer.setData('application/json', JSON.stringify({ paths: pathsToDrag }));
      e.dataTransfer.setData('text/plain', JSON.stringify({ paths: pathsToDrag }));
      e.dataTransfer.effectAllowed = 'copyMove';

      // Create a crisp, high-definition preview badge with actual photo thumbnail
      const ghost = document.createElement('div');
      ghost.style.position = 'fixed';
      ghost.style.left = '0';
      ghost.style.top = '0';
      ghost.style.zIndex = '-9999';
      ghost.style.opacity = '0.01';
      ghost.style.pointerEvents = 'none';
      ghost.style.display = 'flex';
      ghost.style.alignItems = 'center';
      ghost.style.gap = '8px';
      ghost.style.padding = '6px 12px 6px 6px';
      ghost.style.background = '#0f172a';
      ghost.style.color = '#ffffff';
      ghost.style.borderRadius = '10px';
      ghost.style.border = '1.5px solid #0284c7';
      ghost.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';

      const thumb = mediumThumbnails[photo.path] || thumbnails[photo.path];
      if (thumb) {
        const img = document.createElement('img');
        img.src = thumb;
        img.style.width = '48px';
        img.style.height = '48px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '6px';
        img.style.border = '1px solid rgba(255,255,255,0.2)';
        ghost.appendChild(img);
      }

      const textDiv = document.createElement('div');
      textDiv.style.display = 'flex';
      textDiv.style.flexDirection = 'column';
      textDiv.style.maxWidth = '180px';

      const titleSpan = document.createElement('span');
      titleSpan.style.fontSize = '12px';
      titleSpan.style.fontWeight = '600';
      titleSpan.style.overflow = 'hidden';
      titleSpan.style.textOverflow = 'ellipsis';
      titleSpan.style.whiteSpace = 'nowrap';
      titleSpan.innerText =
        pathsToDrag.length > 1
          ? `📍 ${pathsToDrag.length} ${t('library.map.photosCount', { defaultValue: 'photos' })}`
          : `📍 ${photo.path.split(/[\\/]/).pop()}`;
      textDiv.appendChild(titleSpan);

      ghost.appendChild(textDiv);
      document.body.appendChild(ghost);

      // Force layout calculation so browser paints at high resolution
      ghost.getBoundingClientRect();

      e.dataTransfer.setDragImage(ghost, 28, 28);
      setTimeout(() => {
        if (document.body.contains(ghost)) {
          document.body.removeChild(ghost);
        }
      }, 0);
    },
    [selectedDockPaths, onImageClick, mediumThumbnails, thumbnails, t],
  );

  // Photo drag end handler
  const handlePhotoDragEnd = useCallback(() => {
    setIsDraggingOverMap(false);
  }, []);

  const activeLayer = MAP_LAYERS[tileStyle] || MAP_LAYERS.dark;

  const handleFitBounds = useCallback(() => {
    if (!mapRef.current || geotaggedPhotos.length === 0) return;
    try {
      const latLngs = geotaggedPhotos.map((p) => [p.lat, p.lon] as [number, number]);
      const bounds = L.latLngBounds(latLngs);
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      }
    } catch (e) {
      console.error('Failed to fit bounds', e);
    }
  }, [geotaggedPhotos]);

  const initialSelectedPhoto = useMemo(() => {
    if (!effectiveSelectedPath) return null;
    return geotaggedPhotos.find((p) => p.path === effectiveSelectedPath) || null;
  }, [effectiveSelectedPath, geotaggedPhotos]);

  const initialCenter: [number, number] = useMemo(() => {
    if (initialSelectedPhoto) {
      return [initialSelectedPhoto.lat, initialSelectedPhoto.lon];
    }
    if (geotaggedPhotos.length > 0) {
      return [geotaggedPhotos[0].lat, geotaggedPhotos[0].lon];
    }
    return [20, 0];
  }, [initialSelectedPhoto, geotaggedPhotos]);

  const initialZoom: number = initialSelectedPhoto ? 16 : geotaggedPhotos.length > 0 ? 5 : 2;

  // Auto-reveal and highlight unlocated photo in dock if selected from any module
  useEffect(() => {
    if (!effectiveSelectedPath) return;
    const isUnlocated = unlocatedPhotos.some((p) => p.path === effectiveSelectedPath);
    if (isUnlocated) {
      setIsDockOpen(true);
      setSelectedDockPaths(new Set([effectiveSelectedPath]));
    }
  }, [effectiveSelectedPath, unlocatedPhotos]);

  return (
    <div className="relative flex w-full h-full bg-bg-primary overflow-hidden select-none">
      {/* Transparent overlay during dock drag to prevent event stealing and maintain cursor */}
      {isResizingState && <div className="fixed inset-0 z-[9999] cursor-col-resize select-none" />}
      {/* Left Area: Map Canvas & Controls */}
      <div
        className="flex-1 h-full relative"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!isDraggingOverMap) setIsDraggingOverMap(true);
        }}
        onDragLeave={(e) => {
          const related = e.relatedTarget as Node | null;
          if (!related || !e.currentTarget.contains(related)) {
            setIsDraggingOverMap(false);
          }
        }}
        onDrop={handleMapDrop}
      >
        {/* Geotagged Info Badge on Map */}
        <div className="absolute top-4 left-4 z-[1000] flex items-center gap-2 bg-surface/90 border border-border-color/30 backdrop-blur-md px-3 py-1.5 rounded-lg shadow-lg">
          <MapPin className="w-4 h-4 text-accent shrink-0" />
          <span className="text-xs font-medium text-text-primary">
            {t('library.map.badge', {
              count: geotaggedCount,
              total: totalPhotos,
              defaultValue: `${geotaggedCount} / ${totalPhotos} with GPS coordinates`,
            })}
          </span>
        </div>

        {/* Drag over map overlay indicator - Crisp map without blur, unobtrusive top banner */}
        {isDraggingOverMap && (
          <div className="absolute inset-0 z-[1100] pointer-events-none border-2 border-accent border-dashed">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-surface/95 border border-accent text-text-primary px-4 py-2 rounded-xl shadow-2xl flex items-center gap-2 animate-in fade-in zoom-in-95 duration-150">
              <MapPin className="w-4 h-4 text-accent animate-bounce" />
              <span className="text-xs font-semibold">
                {t('library.map.dropToGeotag', { defaultValue: 'Drop onto map to geotag' })}
              </span>
            </div>
          </div>
        )}

        {/* No GPS Warning overlay if folder has photos but none have GPS and dock is closed */}
        {geotaggedCount === 0 && totalPhotos > 0 && !isDockOpen && (
          <div className="absolute inset-0 z-[999] pointer-events-none flex items-center justify-center">
            <div className="bg-surface/95 border border-border-color/40 backdrop-blur-md p-6 rounded-xl shadow-2xl text-center max-w-sm pointer-events-auto">
              <MapPin className="w-8 h-8 text-text-secondary mx-auto mb-2 opacity-60" />
              <p className="text-sm font-semibold text-text-primary mb-1">
                {t('library.map.noGpsTitle', { defaultValue: 'No GPS coordinates' })}
              </p>
              <p className="text-xs text-text-secondary mb-3">
                {t('library.map.noGpsDesc', {
                  defaultValue:
                    'None of the photos in this folder contain geographic information in EXIF metadata.',
                })}
              </p>
              <button
                onClick={() => setIsDockOpen(true)}
                className="px-3.5 py-1.5 rounded-lg bg-accent text-button-text text-xs font-semibold shadow hover:opacity-90 transition"
              >
                {t('library.map.openDockToGeotag', { defaultValue: 'Open panel to place them' })}
              </button>
            </div>
          </div>
        )}

        {/* Leaflet Map */}
        <MapContainer
          center={initialCenter}
          zoom={initialZoom}
          className="w-full h-full"
          ref={mapRef}
          attributionControl={true}
        >
          <TileLayer
            key={activeLayer.id}
            attribution={activeLayer.attribution}
            url={activeLayer.url}
            className={activeLayer.className}
            maxZoom={activeLayer.maxZoom}
          />

          <PhotoClusterLayer
            photos={geotaggedPhotos}
            selectedPath={effectiveSelectedPath}
            currentFolderPath={currentFolderPath}
            onSelectPhoto={onImageClick}
            onDoubleClickPhoto={onImageDoubleClick}
            onContextMenuPhoto={onContextMenu}
            onRevertGps={handleRevertGps}
            onMovePhoto={handleMovePhoto}
            onMapContextMenu={handleMapRightClick}
            showThumbnailCards={showThumbnailCards}
            onRequestThumbnails={onRequestThumbnails}
          />
        </MapContainer>

        {/* Map Controls */}
        <MapControls
          onFitBounds={handleFitBounds}
          tileStyle={tileStyle}
          onTileStyleChange={handleTileStyleChange}
          showThumbnailCards={showThumbnailCards}
          onToggleThumbnailCards={handleToggleThumbnailCards}
          isDockOpen={isDockOpen}
          onToggleDock={handleToggleDock}
          unlocatedCount={unlocatedPhotos.length}
          canUndo={canUndo}
          onUndo={handleUndoGps}
        />
      </div>

      {/* Right Dock for Unlocated Photos */}
      <div
        style={{ width: isDockOpen ? dockWidth : 0 }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'none';
          if (isDraggingOverMap) setIsDraggingOverMap(false);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (isDraggingOverMap) setIsDraggingOverMap(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingOverMap(false);
          const rawData =
            e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain');
          if (rawData) {
            try {
              const parsed = JSON.parse(rawData);
              const paths: string[] = Array.isArray(parsed?.paths) ? parsed.paths : [];
              if (paths.length > 0) {
                setSelectedDockPaths(new Set(paths));
                onImageClick?.(paths[0], e as any);
              }
            } catch (err) {
              console.error('Failed to parse dropped data on dock', err);
            }
          }
        }}
        className={`relative shrink-0 border-l border-surface/50 bg-bg-secondary/70 backdrop-blur-md flex flex-col ${
          isResizingState ? '' : 'transition-[width] duration-200 ease-out'
        } z-[1000] ${isDockOpen ? '' : 'overflow-hidden border-none'}`}
      >
        {isDockOpen && (
          <>
            {/* Left border resizer handle */}
            <div
              onMouseDown={startResizing}
              className="absolute top-0 bottom-0 -left-1 w-2.5 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors z-40"
              title={t('library.map.resizeDock', { defaultValue: 'Drag to resize' })}
            />

            {/* Dock Header */}
            <div className="p-3 border-b border-surface/50 flex flex-col gap-1 shrink-0 bg-surface/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MapPinOff className="w-4 h-4 text-amber-500 shrink-0" />
                  <span className="text-xs font-bold text-text-primary uppercase tracking-wide">
                    {t('library.map.unlocatedDockTitle', { defaultValue: 'Unlocated' })}
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-surface border border-border-color/30 text-text-secondary">
                    {unlocatedPhotos.length}
                  </span>
                </div>
                <button
                  onClick={() => setIsDockOpen(false)}
                  className="w-6 h-6 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface/60 transition"
                  title={t('library.map.closeDock', { defaultValue: 'Close panel' })}
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-between mt-1 text-[11px] text-text-secondary">
                <span>
                  {t('library.map.unlocatedDockSubtitle', {
                    defaultValue: 'Drag onto map to geotag',
                  })}
                </span>
                {unlocatedPhotos.length > 1 && (
                  <button
                    onClick={() => {
                      if (selectedDockPaths.size === unlocatedPhotos.length) {
                        setSelectedDockPaths(new Set());
                      } else {
                        const allPaths = unlocatedPhotos.map((p) => p.path);
                        setSelectedDockPaths(new Set(allPaths));
                        if (allPaths.length > 0) {
                          onImageClick?.(allPaths[0], {} as any);
                        }
                      }
                    }}
                    className="text-accent hover:underline text-[10px] font-medium shrink-0 ml-2"
                  >
                    {selectedDockPaths.size === unlocatedPhotos.length
                      ? t('library.map.deselectAll', { defaultValue: 'Deselect all' })
                      : t('library.map.selectAll', { defaultValue: 'Select all' })}
                  </button>
                )}
              </div>
            </div>

            {/* Dock Photo List */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 flex flex-col gap-2">
              {unlocatedPhotos.length === 0 ? (
                <div className="m-auto text-center p-6 flex flex-col items-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-2 opacity-80" />
                  <p className="text-xs font-semibold text-text-primary">
                    {t('library.map.allGeotagged', {
                      defaultValue: 'All photos have GPS coordinates',
                    })}
                  </p>
                </div>
              ) : (
                unlocatedPhotos.map((photo) => {
                  const isSelected =
                    selectedDockPaths.has(photo.path) ||
                    (selectedDockPaths.size === 0 && effectiveSelectedPath === photo.path);
                  const thumb = mediumThumbnails[photo.path] || thumbnails[photo.path];
                  const filename = photo.path.split(/[\\/]/).pop() || '';
                  const timestamp = getImageTimestamp(photo, localExifMap[photo.path]);
                  const exif = localExifMap[photo.path] || photo.exif;
                  const cardHeight = Math.max(120, dockWidth - 16);

                  return (
                    <UnlocatedPhotoCard
                      key={photo.path}
                      photo={photo}
                      filename={filename}
                      timestamp={timestamp}
                      exif={exif}
                      thumbUrl={thumb}
                      isSelected={isSelected}
                      cardHeight={cardHeight}
                      onSelect={(e) => handlePhotoSelect(photo.path, e)}
                      onDoubleClick={() => onImageDoubleClick?.(photo.path)}
                      onContextMenu={(e) => onContextMenu?.(e, photo.path)}
                      onDragStart={(e) => handlePhotoDragStart(photo, e)}
                      onDragEnd={handlePhotoDragEnd}
                      onRequestThumb={queueThumbnailRequest}
                    />
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {/* Floating Map Context Menu */}
      {mapContextMenu && (
        <div
          style={{ top: mapContextMenu.y, left: mapContextMenu.x }}
          className="fixed z-[2000] bg-surface/95 border border-border-color/40 rounded-xl shadow-2xl p-1.5 backdrop-blur-md flex flex-col min-w-48 text-xs text-text-primary animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2.5 py-1 text-[11px] text-text-secondary border-b border-border-color/20 mb-1 flex items-center gap-1 font-medium">
            <MapPin className="w-3.5 h-3.5 text-accent" />
            <span>
              {mapContextMenu.lat.toFixed(5)}°, {mapContextMenu.lon.toFixed(5)}°
            </span>
          </div>
          {(() => {
            const areTargetsGeotagged = mapContextMenu.targetPaths.some((p) => {
              const img = imageList.find((i) => i.path === p);
              return Boolean(getImageGps(img, localExifMap[p]));
            });

            return (
              <button
                onClick={() => {
                  applyGpsToPhotos(
                    mapContextMenu.targetPaths,
                    mapContextMenu.lat,
                    mapContextMenu.lon,
                  );
                  setMapContextMenu(null);
                }}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-accent/20 hover:text-accent transition font-medium"
              >
                <MapPin className="w-4 h-4 text-accent" />
                <span>
                  {areTargetsGeotagged
                    ? t('library.map.repositionSelectedHere', {
                        count: mapContextMenu.targetPaths.length,
                        defaultValue: `Reposition ${mapContextMenu.targetPaths.length} photo(s) here`,
                      })
                    : t('library.map.geotagSelectedHere', {
                        count: mapContextMenu.targetPaths.length,
                        defaultValue: `Place ${mapContextMenu.targetPaths.length} photo(s) here`,
                      })}
                </span>
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}

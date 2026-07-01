import JSZip from 'jszip';
import { offlineDb } from '@/lib/offlineDb';

export async function requestPersistentStorage() {
  if (!navigator.storage) {
    return { supported: false, persisted: false, granted: false };
  }

  const alreadyPersisted = navigator.storage.persisted
    ? await navigator.storage.persisted().catch(() => false)
    : false;

  let granted = alreadyPersisted;
  if (!alreadyPersisted && navigator.storage.persist) {
    granted = await navigator.storage.persist().catch(() => false);
  }

  const estimate = navigator.storage.estimate
    ? await navigator.storage.estimate().catch(() => ({}))
    : {};

  return {
    supported: true,
    persisted: alreadyPersisted || granted,
    granted,
    usage: estimate.usage || 0,
    quota: estimate.quota || 0,
  };
}

export async function getStorageStatus() {
  const persisted = navigator.storage?.persisted
    ? await navigator.storage.persisted().catch(() => false)
    : false;
  const estimate = navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => ({}))
    : {};
  return {
    supported: Boolean(navigator.storage),
    persisted,
    usage: estimate.usage || 0,
    quota: estimate.quota || 0,
  };
}

function safeName(value) {
  return String(value || 'collecte')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'collecte';
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/i.exec(dataUrl || '');
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const encoded = match[2] || '';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { mime, bytes };
}

function extensionForMime(mime) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  return 'jpg';
}

async function saveBlobToPhone(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/zip' });

  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'Sauvegarde Collecte Terrain', accept: { 'application/zip': ['.zip'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { method: 'file-system' };
  }

  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    await navigator.share({ files: [file], title: 'Sauvegarde Collecte Terrain' });
    return { method: 'share' };
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { method: 'download' };
}

export async function exportOfflineBackup() {
  const collectes = await offlineDb.getAllCollectes();
  const zip = new JSZip();
  const exported = [];

  for (const collecte of collectes) {
    const clone = structuredClone(collecte);
    const folderName = `${String(collecte.localId || 'x').padStart(5, '0')}-${safeName(collecte.commune)}-${safeName(collecte.lot || collecte.parcelle)}`;
    const photoFolder = zip.folder(`photos/${folderName}`);

    for (const [key, value] of Object.entries(clone)) {
      if (typeof value !== 'string' || !value.startsWith('data:image/')) continue;
      const decoded = dataUrlToBytes(value);
      if (!decoded) continue;
      const filename = `${safeName(key)}.${extensionForMime(decoded.mime)}`;
      photoFolder.file(filename, decoded.bytes, { binary: true });
      // La valeur originale reste dans backup.json pour permettre une restauration exacte.
    }

    exported.push(clone);
  }

  const manifest = {
    format: 'collecte-terrain-offline-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: exported.length,
    collectes: exported,
  };

  zip.file('backup.json', JSON.stringify(manifest, null, 2));
  zip.file('LISEZ-MOI.txt', [
    'Sauvegarde Collecte Terrain Pro',
    `Date : ${manifest.exportedAt}`,
    `Nombre de collectes : ${manifest.count}`,
    '',
    'Le fichier backup.json permet de restaurer les collectes dans l’application.',
    'Le dossier photos contient également les images extraites pour récupération manuelle.',
  ].join('\n'));

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `collecte-terrain-sauvegarde-${stamp}.zip`;
  await saveBlobToPhone(blob, filename);
  return { filename, count: exported.length, size: blob.size };
}

export async function importOfflineBackup(file, { replace = false } = {}) {
  if (!file) throw new Error('Fichier manquant');
  const zip = await JSZip.loadAsync(file);
  const backupEntry = zip.file('backup.json');
  if (!backupEntry) throw new Error('backup.json absent de la sauvegarde');
  const manifest = JSON.parse(await backupEntry.async('string'));
  if (manifest?.format !== 'collecte-terrain-offline-backup' || !Array.isArray(manifest.collectes)) {
    throw new Error('Format de sauvegarde non reconnu');
  }
  const count = await offlineDb.importCollectes(manifest.collectes, { replace });
  return { count, exportedAt: manifest.exportedAt };
}

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Mo';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 2 ? 1 : 0)} ${units[index]}`;
}

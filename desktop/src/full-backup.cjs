// Full dbFox backup: connections (with saved passwords), groups, settings, SQL favorites, SQL file references,
// trusted SSH hosts, dashboards and the interface state kept in localStorage. Encrypted with AES-256-GCM (scrypt key).
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validatePayload, restorePackage } = require('./connection-transfer.cjs');
const { validateSettings } = require('./settings.cjs');
const scrypt = promisify(crypto.scrypt);

const FORMAT = 'LQTAC dbFox full backup', ENVELOPE = 'LQTAC dbFox encrypted full backup';
const MAX_BYTES = 256 * 1024 * 1024;
const SINGLE_FILES = ['settings.json', 'sql-favorites.json', 'sql-file-references.json', 'ssh-known-hosts.json'];
const DASHBOARD_FILE = /^dashboards\/[a-zA-Z0-9-]{1,80}\.json$/;
const LOCAL_KEY = /^lqtac\.[A-Za-z0-9_.:-]{1,100}$/;

function checkPassphrase(value) { if (typeof value !== 'string' || value.length < 8 || value.length > 1024) throw Error('La contraseña del archivo debe tener entre 8 y 1024 caracteres.'); }
function validateLocal(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw Error('El estado de la interfaz no es válido.');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LOCAL_KEY.test(key) || typeof value !== 'string' || value.length > 64 * 1024 * 1024) throw Error('El estado de la interfaz contiene una clave no válida: ' + key);
    result[key] = value;
  }
  return result;
}
function validateFiles(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('La lista de archivos de la copia no es válida.');
  const result = {};
  for (const [name, content] of Object.entries(input)) {
    if (!SINGLE_FILES.includes(name) && !DASHBOARD_FILE.test(name)) throw Error('La copia contiene un archivo no permitido: ' + name);
    if (typeof content !== 'string') throw Error('Contenido no válido en ' + name);
    let parsed; try { parsed = JSON.parse(content); } catch { throw Error('El archivo ' + name + ' de la copia no es JSON válido.'); }
    if (name === 'settings.json') validateSettings(parsed);
    if (name === 'sql-favorites.json' && (!Array.isArray(parsed) || !parsed.every(x => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.sql === 'string'))) throw Error('Los favoritos SQL de la copia no son válidos.');
    if (name.startsWith('dashboards/') && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw Error('El dashboard ' + name + ' de la copia no es válido.');
    result[name] = content;
  }
  return result;
}
function validateBackup(input) {
  if (!input || input.format !== FORMAT || input.version !== 1) throw Error('El archivo no es una copia completa de dbFox compatible.');
  return { format: FORMAT, version: 1, appVersion: String(input.appVersion || ''), exportedAt: String(input.exportedAt || ''), connections: validatePayload(input.connections), files: validateFiles(input.files), localStorage: validateLocal(input.localStorage) };
}
function summarize(backup, skippedPasswords = 0) {
  const names = Object.keys(backup.files), parse = name => { try { return JSON.parse(backup.files[name]); } catch { return null; } };
  return {
    appVersion: backup.appVersion, exportedAt: backup.exportedAt,
    profiles: backup.connections.profiles.length, groups: backup.connections.groups.length, passwords: backup.connections.passwords.length, skippedPasswords,
    dashboards: names.filter(name => name.startsWith('dashboards/')).length,
    favorites: Array.isArray(parse('sql-favorites.json')) ? parse('sql-favorites.json').length : 0,
    sqlFiles: names.includes('sql-file-references.json') ? (Array.isArray(parse('sql-file-references.json')) ? parse('sql-file-references.json').length : 1) : 0,
    settings: names.includes('settings.json'), sshHosts: names.includes('ssh-known-hosts.json'),
    interfaceKeys: Object.keys(backup.localStorage).length
  };
}
async function readIfExists(file) { try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

async function collectBackup(directory, connections, credentials, localState, appVersion) {
  const profiles = await connections.list(), groups = await connections.groups(), passwords = []; let skippedPasswords = 0;
  for (const profile of profiles) {
    if (!(await credentials.has(profile.id))) continue;
    // A password saved on another machine or Windows account cannot be decrypted here: export the rest.
    try { passwords.push({ id: profile.id, password: await credentials.get(profile.id) }); } catch { skippedPasswords++; }
  }
  const files = {};
  for (const name of SINGLE_FILES) { const content = await readIfExists(path.join(directory, name)); if (content !== null) files[name] = content; }
  let entries = []; try { entries = await fs.readdir(path.join(directory, 'dashboards')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) { const name = 'dashboards/' + entry; if (DASHBOARD_FILE.test(name)) files[name] = await fs.readFile(path.join(directory, 'dashboards', entry), 'utf8'); }
  const backup = validateBackup({ format: FORMAT, version: 1, appVersion, exportedAt: new Date().toISOString(), connections: { format: 'LQTAC Connections', version: 1, profiles, groups, passwords }, files, localStorage: localState });
  return { backup, summary: summarize(backup, skippedPasswords) };
}
async function encryptBackup(backup, passphrase) {
  checkPassphrase(passphrase);
  const data = Buffer.from(JSON.stringify(validateBackup(backup)), 'utf8');
  if (data.length > MAX_BYTES) throw Error('La copia completa supera 256 MB.');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = await scrypt(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]); key.fill(0); data.fill(0);
  return JSON.stringify({ format: ENVELOPE, version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
async function decryptBackup(content, passphrase) {
  checkPassphrase(passphrase);
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES * 2) throw Error('El archivo supera el tamaño permitido.');
  let envelope; try { envelope = JSON.parse(content); } catch { throw Error('El archivo no tiene un formato válido.'); }
  if (!envelope || envelope.format !== ENVELOPE || envelope.version !== 1 || !['salt', 'iv', 'tag', 'data'].every(k => typeof envelope[k] === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(envelope[k]))) throw Error('El archivo no es una copia completa de dbFox compatible.');
  const salt = Buffer.from(envelope.salt, 'base64'), iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64'), encrypted = Buffer.from(envelope.data, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || encrypted.length > MAX_BYTES) throw Error('El archivo no es válido.');
  const key = await scrypt(passphrase, salt, 32); let plain;
  try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); plain = Buffer.concat([decipher.update(encrypted), decipher.final()]); }
  catch { throw Error('La contraseña del archivo es incorrecta o el archivo está dañado.'); } finally { key.fill(0); }
  let value; try { value = JSON.parse(plain.toString('utf8')); } catch { throw Error('El contenido del archivo no es válido.'); } finally { plain.fill(0); }
  return validateBackup(value);
}
async function writeAtomic(file, content) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file + '.tmp', content, { mode: 0o600 }); await fs.rename(file + '.tmp', file); }

// Replaces the current configuration with the backup. The previous files are kept in Data/restore-backups/<fecha>.
async function restoreBackup(directory, connections, credentials, input) {
  const backup = validateBackup(input);
  const backupDir = path.join(directory, 'restore-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(backupDir, { recursive: true });
  for (const name of [...SINGLE_FILES, 'connections.json', 'connection-groups.json', 'credentials.json']) { const content = await readIfExists(path.join(directory, name)); if (content !== null) await fs.writeFile(path.join(backupDir, name), content, { mode: 0o600 }); }
  try { await fs.cp(path.join(directory, 'dashboards'), path.join(backupDir, 'dashboards'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Connections first: it validates secure storage and rolls itself back if it cannot complete.
  await restorePackage(connections, credentials, backup.connections);
  for (const name of SINGLE_FILES) {
    const file = path.join(directory, name);
    if (backup.files[name] !== undefined) await writeAtomic(file, backup.files[name]);
    else await fs.rm(file, { force: true });
  }
  const dashboards = path.join(directory, 'dashboards');
  await fs.rm(dashboards, { recursive: true, force: true }); await fs.mkdir(dashboards, { recursive: true });
  for (const [name, content] of Object.entries(backup.files)) if (name.startsWith('dashboards/')) await writeAtomic(path.join(directory, ...name.split('/')), content);
  return { summary: summarize(backup), localStorage: backup.localStorage, backupDir };
}
module.exports = { collectBackup, encryptBackup, decryptBackup, restoreBackup, validateBackup, summarize, MAX_BYTES };

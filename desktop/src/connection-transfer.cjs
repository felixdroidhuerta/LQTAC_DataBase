const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validateProfile } = require('./connections.cjs');
const scrypt = promisify(crypto.scrypt);
const MAX_BYTES = 10 * 1024 * 1024;

function validatePayload(input) {
  if (!input || input.format !== 'LQTAC Connections' || input.version !== 1 || !Array.isArray(input.profiles) || !Array.isArray(input.groups) || !Array.isArray(input.passwords) || input.profiles.length > 1000 || input.groups.length > 1000 || input.passwords.length > input.profiles.length) throw Error('El contenido del archivo no es válido.');
  const validId = id => typeof id === 'string' && /^[a-z0-9-]{1,128}$/i.test(id);
  const ids = new Set();
  const profiles = input.profiles.map(item => { if (!item || !validId(item.id) || ids.has(item.id)) throw Error('Identificador de conexión no válido o duplicado.'); ids.add(item.id); return { id: item.id, ...validateProfile(item) }; });
  const groupIds = new Set(), assigned = new Set();
  const groups = input.groups.map(group => {
    if (!group || !validId(group.id) || groupIds.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || !Array.isArray(group.connectionIds) || group.connectionIds.length > profiles.length) throw Error('Grupo no válido.');
    groupIds.add(group.id);
    for (const id of group.connectionIds) { if (!ids.has(id) || assigned.has(id)) throw Error('Conexión de grupo no válida o duplicada.'); assigned.add(id); }
    return { id: group.id, name: group.name, connectionIds: [...group.connectionIds] };
  });
  const passwordIds = new Set();
  const passwords = input.passwords.map(item => { if (!item || !ids.has(item.id) || passwordIds.has(item.id) || typeof item.password !== 'string' || item.password.length > 4096) throw Error('Contraseña de conexión no válida.'); passwordIds.add(item.id); return { id: item.id, password: item.password }; });
  return { format: 'LQTAC Connections', version: 1, profiles, groups, passwords };
}
function checkPassphrase(value) { if (typeof value !== 'string' || value.length < 8 || value.length > 1024) throw Error('La contraseña del archivo debe tener entre 8 y 1024 caracteres.'); }
async function encryptPackage(payload, passphrase) {
  checkPassphrase(passphrase); const data = Buffer.from(JSON.stringify(validatePayload(payload)));
  if (data.length > MAX_BYTES) throw Error('La copia supera el tamaño permitido.');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = await scrypt(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]); key.fill(0);
  return JSON.stringify({ format: 'LQTAC encrypted connections', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
async function decryptPackage(content, passphrase) {
  checkPassphrase(passphrase); if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES * 2) throw Error('El archivo supera el tamaño permitido.');
  let envelope; try { envelope = JSON.parse(content); } catch { throw Error('El archivo no tiene un formato válido.'); }
  if (!envelope || envelope.format !== 'LQTAC encrypted connections' || envelope.version !== 1 || !['salt','iv','tag','data'].every(k => typeof envelope[k] === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(envelope[k]))) throw Error('El archivo no es una copia de conexiones compatible.');
  const salt=Buffer.from(envelope.salt,'base64'), iv=Buffer.from(envelope.iv,'base64'), tag=Buffer.from(envelope.tag,'base64'), encrypted=Buffer.from(envelope.data,'base64');
  if (salt.length!==16 || iv.length!==12 || tag.length!==16 || encrypted.length>MAX_BYTES) throw Error('El archivo no es válido.');
  const key=await scrypt(passphrase,salt,32); let plain;
  try { const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag); plain=Buffer.concat([decipher.update(encrypted),decipher.final()]); }
  catch { throw Error('La contraseña del archivo es incorrecta o el archivo está dañado.'); } finally { key.fill(0); }
  let value; try { value=JSON.parse(plain.toString('utf8')); } catch { throw Error('El contenido del archivo no es válido.'); } finally { plain.fill(0); }
  return validatePayload(value);
}
async function restorePackage(connections, credentials, payload) {
  const value=validatePayload(payload);
  if (value.passwords.length && !credentials.storage.isEncryptionAvailable()) throw Error('No está disponible el almacenamiento seguro de contraseñas en este equipo.');
  const encrypted = Object.create(null);
  for (const item of value.passwords) encrypted[item.id]=credentials.storage.encryptString(item.password).toString('base64');
  return connections.mutate(async () => {
    await credentials.pending;
    const previous = { profiles: await connections.list(), groups: await connections.groups(), passwords: await credentials.read() };
    await connections.write(require('node:path').join(require('node:path').dirname(connections.file),'connections-restore-backup.json'), previous);
    try {
      await connections.write(connections.file,value.profiles);
      await connections.write(connections.groupsFile,value.groups);
      await connections.write(credentials.file,encrypted);
    } catch (error) {
      try { await connections.write(connections.file,previous.profiles); await connections.write(connections.groupsFile,previous.groups); await connections.write(credentials.file,previous.passwords); }
      catch { throw Error('No se pudo completar ni revertir la restauración. Revisa las copias de tus conexiones.'); }
      throw error;
    }
    return { profiles:value.profiles.length, groups:value.groups.length, passwords:value.passwords.length };
  });
}
module.exports = { encryptPackage, decryptPackage, validatePayload, restorePackage, MAX_BYTES };

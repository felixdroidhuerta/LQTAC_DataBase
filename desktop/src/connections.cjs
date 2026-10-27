const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const engines = new Set(['postgresql', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'clickhouse', 'mongodb']);
function validateProfile(input) {
  if (!input || !engines.has(input.engine)) throw new Error('Selecciona un motor válido.');
  const profile = { engine: input.engine };
  for (const key of ['name', 'host', 'username']) {
    const value = key === 'username' && input.engine === 'mongodb' ? input[key] ?? '' : input[key];
    if (typeof value !== 'string' || (!value.trim() && !(key === 'username' && input.engine === 'mongodb')) || value.length > 255) throw new Error(`Campo no válido: ${key}.`);
    profile[key] = value.trim();
  }
  if (input.database !== undefined && (typeof input.database !== 'string' || input.database.length > 255)) throw new Error('Campo no válido: database.');
  profile.database = (input.database ?? '').trim();
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('El puerto debe estar entre 1 y 65535.');
  profile.port = port;
  if (input.tls === true) profile.tls = true;
  if (input.engine === 'mongodb' && input.authSource) {
    if (typeof input.authSource !== 'string' || input.authSource.length > 255 || /[\/\\. "$\0]/.test(input.authSource)) throw new Error('Base de autenticación MongoDB no válida.');
    profile.authSource = input.authSource.trim();
  }
  if (['clickhouse', 'mongodb'].includes(input.engine) && /[\s\/?#@]/.test(profile.host)) throw new Error('Introduce solo el nombre o IP del servidor, sin protocolo, ruta ni credenciales.');
  return profile;
}

class ConnectionStore {
  constructor(directory) { this.file = path.join(directory, 'connections.json'); this.groupsFile = path.join(directory, 'connection-groups.json'); this.trashFile = path.join(directory, 'connections-trash.json'); this.pending = Promise.resolve(); }
  mutate(action) { const operation = this.pending.then(action); this.pending = operation.catch(() => {}); return operation; }
  async write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); }
  async list() {
    try {
      const profiles = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(profiles)) throw new Error('Formato de perfiles incorrecto.');
      return profiles.map(profile => ({ id: profile.id, ...validateProfile(profile) }));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(input) {
    return this.mutate(async () => {
      const profile = validateProfile(input);
      const profiles = await this.list();
      const existing = profiles.findIndex(p => p.id === input.id);
      const saved = { id: existing >= 0 ? profiles[existing].id : randomUUID(), ...profile };
      if (existing >= 0) profiles[existing] = saved;
      else profiles.push(saved);
      await this.write(this.file, profiles);
      return saved;
    });
  }
  async groups() {
    let groups;
    try { groups = JSON.parse(await fs.readFile(this.groupsFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!Array.isArray(groups) || !groups.every(group => typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.connectionIds))) throw new Error('Formato de grupos no válido.');
    const known = new Set((await this.list()).map(profile => profile.id));
    const assigned = new Set();
    return groups.map(group => ({ id: group.id, name: group.name, connectionIds: group.connectionIds.filter(id => { if (!known.has(id) || assigned.has(id)) return false; assigned.add(id); return true; }) }));
  }
  async validateIds(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(id => typeof id === 'string')) throw new Error('Selecciona conexiones válidas.');
    const profiles = await this.list();
    if (ids.some(id => !profiles.some(profile => profile.id === id))) throw new Error('Una de las conexiones ya no existe. Actualiza el explorador.');
    return [...new Set(ids)];
  }
  createGroup(name, ids) {
    return this.mutate(async () => {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('El nombre del grupo debe tener entre 1 y 80 caracteres.');
      const selected = await this.validateIds(ids);
      const groups = await this.groups();
      if (groups.some(group => group.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) throw new Error('Ya existe un grupo con ese nombre.');
      for (const group of groups) group.connectionIds = group.connectionIds.filter(id => !selected.includes(id));
      const created = { id: randomUUID(), name: name.trim(), connectionIds: selected };
      groups.push(created); await this.write(this.groupsFile, groups); return created;
    });
  }
  move(ids, groupId = null) {
    return this.mutate(async () => {
      const selected = await this.validateIds(ids); const groups = await this.groups();
      const target = groupId === null ? null : groups.find(group => group.id === groupId);
      if (groupId !== null && !target) throw new Error('El grupo ya no existe.');
      for (const group of groups) group.connectionIds = group.connectionIds.filter(id => !selected.includes(id));
      if (target) target.connectionIds.push(...selected);
      await this.write(this.groupsFile, groups); return groups;
    });
  }
  ungroup(groupId) {
    return this.mutate(async () => { const groups = await this.groups(); if (!groups.some(group => group.id === groupId)) throw new Error('El grupo ya no existe.'); await this.write(this.groupsFile, groups.filter(group => group.id !== groupId)); });
  }
  remove(ids) {
    return this.mutate(async () => {
      const selected = await this.validateIds(ids); const profiles = await this.list();
      let trash = [];
      try { trash = JSON.parse(await fs.readFile(this.trashFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(trash)) throw new Error('No se pudo guardar una copia de los perfiles.');
      await this.write(this.trashFile, [...trash, ...profiles.filter(profile => selected.includes(profile.id)).map(profile => ({ ...profile, removedAt: new Date().toISOString() }))]);
      const groups = await this.groups();
      await this.write(this.file, profiles.filter(profile => !selected.includes(profile.id)));
      await this.write(this.groupsFile, groups.map(group => ({ ...group, connectionIds: group.connectionIds.filter(id => !selected.includes(id)) })));
      return selected;
    });
  }
}
module.exports = { ConnectionStore, validateProfile };

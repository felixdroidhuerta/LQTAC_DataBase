export function bindQuery(tab,connection){
  if(!connection?.connected)throw new Error('La conexión está cerrada. Conecta su perfil antes de ejecutar.');
  if(tab.connectionKey&&tab.connectionKey!==connection.sessionKey)throw new Error('La consulta pertenece a otra conexión.');
  const changed=tab.connectionProfileSignature&&connection.profileSignature&&tab.connectionProfileSignature!==connection.profileSignature;
  tab.connectionKey=connection.sessionKey;tab.connectionName=connection.name;tab.connectionEngine=connection.engine;
  if(changed||typeof tab.connectionDatabase!=='string')tab.connectionDatabase=connection.database||'';
  if(changed||typeof tab.connectionDatabaseName!=='string')tab.connectionDatabaseName=connection.databaseName||'';
  tab.connectionProfileSignature=connection.profileSignature||null;
  return {database:tab.connectionDatabase,databaseName:tab.connectionDatabaseName};
}

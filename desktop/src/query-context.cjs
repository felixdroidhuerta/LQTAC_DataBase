const {identifier}=require('./adapters/sql-common.cjs');
async function restoreQueryContext(adapter,engine,context,schemas){
  if(context===undefined)return null;
  if(!context||typeof context!=='object'||Array.isArray(context))throw new Error('Contexto de consulta no válido.');
  for(const key of ['database','databaseName'])if(context[key]!==undefined&&(typeof context[key]!=='string'||context[key].length>255||context[key].includes('\0')))throw new Error('Base de consulta no válida.');
  if(engine==='sqlserver'&&context.databaseName){
    await adapter.currentDatabase();
    if(adapter.databaseName!==context.databaseName){await adapter.execute('USE '+identifier(context.databaseName,'sqlserver'));return adapter.catalog();}
    return null;
  }
  if(context.database&&adapter.selectDatabase){
    if(!schemas.some(item=>item.name===context.database))throw new Error('La base o esquema de esta consulta no está disponible. Actualiza el explorador y selecciona una base válida.');
    if(await adapter.currentDatabase()!==context.database)await adapter.selectDatabase(context.database);
  }
  return null;
}
module.exports={restoreQueryContext};

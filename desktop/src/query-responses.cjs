// Keep the original snapshot identity for optimistic editing while its SQL tab is open.
class QueryResponses{
 constructor(){this.entries=new Map();this.history=new Map();}
 remember(id,snapshot){
  if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id)||!snapshot?.token)throw Error('Consulta no válida.');
  if(!this.history.has(id)||!snapshot.session)this.history.set(id,new Map());
  const history=this.history.get(id);
  for(const [token,previous] of history)if(previous.session===snapshot.session)history.delete(token);
  history.set(snapshot.token,snapshot);this.entries.set(id,snapshot);
 }
 find(token){if(typeof token!=='string')return null;for(const snapshots of this.history.values())if(snapshots.has(token))return snapshots.get(token);return null;}
 forget(id){const snapshot=this.entries.get(id);this.entries.delete(id);this.history.delete(id);return snapshot;}
}
module.exports={QueryResponses};

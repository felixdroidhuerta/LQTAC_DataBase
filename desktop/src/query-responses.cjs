// Keep the original snapshot identity for optimistic editing while its SQL tab is open.
class QueryResponses{
 constructor(){this.entries=new Map();}
 remember(id,snapshot){if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id)||!snapshot?.token)throw Error('Consulta no válida.');this.entries.set(id,snapshot);}
 find(token){if(typeof token!=='string')return null;return [...this.entries.values()].find(snapshot=>snapshot.token===token)||null;}
 forget(id){const snapshot=this.entries.get(id);this.entries.delete(id);return snapshot;}
}
module.exports={QueryResponses};

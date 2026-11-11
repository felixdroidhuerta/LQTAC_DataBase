const fs=require('node:fs');
const path=require('node:path');
function verifySSHHost(profile,fingerprint,options={}) {
 const explicit=(profile.sshFingerprint||'').replace(/=+$/,'');
 if(explicit)return explicit===fingerprint;
 const file=options.file||path.join(require('electron').app.getPath('userData'),'ssh-known-hosts.json');
 let known={};
 try{known=JSON.parse(fs.readFileSync(file,'utf8'));if(!known||typeof known!=='object'||Array.isArray(known))throw Error('Archivo de identidades SSH no válido.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const endpoint=JSON.stringify([profile.sshHost.toLowerCase(),Number(profile.sshPort||22)]);
 if(Object.hasOwn(known,endpoint)){
   if(known[endpoint]!==fingerprint)throw Error('La identidad del servidor SSH ha cambiado. Verifica el cambio con su administrador.');
   return true;
 }
 const confirm=options.confirm||(()=>require('electron').dialog.showMessageBoxSync({type:'question',title:'Verificar servidor SSH',message:'Primera conexión con '+profile.sshHost+':'+(profile.sshPort||22),detail:'Huella del servidor:\n'+fingerprint+'\n\nComprueba esta identidad con el administrador. ¿Confiar y recordarla en este equipo?',buttons:['Cancelar','Confiar y conectar'],defaultId:0,cancelId:0,noLink:true})===1);
 if(!confirm(fingerprint))return false;
 known[endpoint]=fingerprint;
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file+'.tmp',JSON.stringify(known,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);
 return true;
}
module.exports={verifySSHHost};

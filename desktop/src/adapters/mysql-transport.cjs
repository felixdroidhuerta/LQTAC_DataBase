const {createHash}=require('node:crypto');
const fs=require('node:fs/promises');
const {verifySSHHost}=require('./ssh-trust.cjs');

async function mysqlTransport(profile) {
  if(profile.method==='socket')return {options:{socketPath:profile.socketPath},close(){}};
  if(profile.method!=='ssh')return {options:{},close(){}};
  const {Client}=require('ssh2');
  const client=new Client();
  const passwordAuth=profile.sshAuth==='password';
  if(passwordAuth&&typeof profile.sshPassword!=='string')throw Error('Introduce la contraseña SSH.');
  const privateKey=!passwordAuth&&profile.sshKeyPath?await fs.readFile(profile.sshKeyPath):undefined;
  let verificationError;
  let stream;
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{client.destroy();reject(Error('Tiempo de conexión SSH agotado.'));},15000);
      client.once('ready',()=>{clearTimeout(timer);resolve();});
      client.on('error',error=>{clearTimeout(timer);reject(error);});
      client.connect({host:profile.sshHost,port:profile.sshPort||22,username:profile.sshUser,
        privateKey,password:passwordAuth?profile.sshPassword:undefined,agent:passwordAuth||privateKey?undefined:(process.env.SSH_AUTH_SOCK||(process.platform==='win32'?'pageant':undefined)),
        readyTimeout:10000,keepaliveInterval:15000,keepaliveCountMax:3,
        hostVerifier:key=>{try{return verifySSHHost(profile,'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,''));}catch(error){verificationError=error;return false;}}});
    });
    stream=await new Promise((resolve,reject)=>client.forwardOut('127.0.0.1',0,profile.host,profile.port,(error,value)=>error?reject(error):resolve(value)));
    stream.on('error',()=>{});
    client.on('close',()=>stream.destroy());
    return {options:{stream:()=>stream},close(){stream.destroy();client.destroy();}};
  } catch(error){client.destroy();throw Error('No se pudo abrir el túnel SSH: '+(verificationError||error).message);}
}
module.exports={mysqlTransport};

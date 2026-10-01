#!/usr/bin/env node
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {randomBytes}=require('node:crypto');
const {spawn}=require('node:child_process');
async function main(){
  const listener=net.createServer();
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deviceyard-community-smoke-'));
  const password=randomBytes(24).toString('hex');
  const child=spawn(process.execPath,['dist/entry.js'],{cwd:path.resolve(__dirname,'..'),stdio:'ignore',env:{
    PATH:process.env.PATH,HOME:dir,TMPDIR:os.tmpdir(),NODE_ENV:'test',PORT:String(port),DATA_DIR:dir,
    DEVICE_ID:'smoke-device',TOKENS_JSON:'{}',ADMIN_USERNAME:'smoke',ADMIN_EMAIL:'smoke@example.invalid',
    ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(32).toString('hex'),TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')
  }});
  let spawnError;child.on('error',err=>{spawnError=err;});
  try{
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<100;i++){
      if(spawnError||child.exitCode!==null)throw Error('Compiled entrypoint exited before becoming ready');
      try{const r=await fetch(base+'/login',{signal:AbortSignal.timeout(1000)});if(r.status===200){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!ready)throw Error('Compiled entrypoint did not serve its dashboard');
    const login=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'smoke',password})});
    if(login.status!==200)throw Error('Smoke login failed');
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(base+'/api/edition',{headers:{cookie}});
    const edition=await response.json();
    if(response.status!==200||edition.edition!=='community'||edition.multiDevice!==false)throw Error('Entrypoint did not enforce Community policy');
    console.log('Compiled Community boots, serves dashboard, and reports single-device policy');
  }finally{
    if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},3000))]);}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});

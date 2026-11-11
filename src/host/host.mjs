import {readFile,writeFile,rename,mkdir,access,open,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const frida=await import(process.env.INLINEGIF_FRIDA||pathToFileURL(path.join(root,'node_modules/frida/build/src/frida.js')).href);
const runtimeDir=path.join(root,'runtime'),cacheDir=path.join(root,'cache'),agentDir=path.join(root,'agent');
await mkdir(runtimeDir,{recursive:true});await mkdir(cacheDir,{recursive:true});
const controlPath=path.join(root,'control.json'),indexPath=path.join(cacheDir,'index.json');
const programFiles=process.env['ProgramFiles(x86)']||process.env.ProgramFiles;
if(!process.env.INLINEGIF_KAKAO_PATH&&!programFiles)throw new Error('Windows Program Files location is unavailable');
const targetPath=process.env.INLINEGIF_KAKAO_PATH||path.join(programFiles,'Kakao','KakaoTalk','KakaoTalk.exe');
const supportedHash='ec0f43b67cc7e81544464f649a5dfbd690776968014d34d7c554b7a9382a2290';
const sha=b=>createHash('sha256').update(b).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let writeSequence=0;
const atomic=async(file,value)=>{const temporary=file+'.'+process.pid+'.'+(++writeSequence)+'.tmp';await writeFile(temporary,JSON.stringify(value));try{for(let attempt=0;;attempt++){try{await rename(temporary,file);break;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=12)throw error;await wait(15+attempt*10);}}}finally{try{await unlink(temporary);}catch{}}};
let stop=false,enabled=true,session=null,script=null,appPid=null,lastState=null,disconnected=false,initialized=false;
let assets={};try{assets=JSON.parse(await readFile(indexPath,'utf8')).assets||{};}catch{}
const renderers=new Map(),pendingWrites=new Set();let cacheQueue=Promise.resolve();
const statePath=path.join(runtimeDir,'host-state.json');
function log(type,details={}){console.log(JSON.stringify({time:new Date().toISOString(),type,...details}));}
process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
async function readControl(){
  try{const c=JSON.parse(await readFile(controlPath,'utf8'));if(c.enabled!==undefined&&typeof c.enabled!=='boolean')throw new Error('Invalid enabled');if(c.shutdown!==undefined&&typeof c.shutdown!=='boolean')throw new Error('Invalid shutdown');enabled=c.enabled!==false;if(c.shutdown===true)stop=true;}catch(error){if(error.code!=='ENOENT')log('control-error',{error:error.message});}
}
async function saveSource(meta,data){
  if(!data||!meta.assetKey||meta.assetKey.length>200||meta.frameCount<2)return;
  const bytes=Buffer.from(data);if(bytes.length<14||bytes.length>33554432||!['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return;
  const name=sha(bytes)+'.gif',file=path.join(cacheDir,name);
  try{await access(file);}catch{const temp=file+'.tmp';await writeFile(temp,bytes);await rename(temp,file);}
  assets[meta.assetKey]={file:name,frameCount:meta.frameCount,width:meta.width,height:meta.height,updated:new Date().toISOString()};
  await atomic(indexPath,{schemaVersion:1,assets});
  log('source-ready',{assetKey:meta.assetKey,frames:meta.frameCount,bytes:bytes.length});
}
function onMessage(message,data){
  if(message.type==='error'){log('agent-error',{error:message.description,stack:message.stack});return;}
  const event=message.payload;if(!event)return;
  if(event.kind==='source-event'){
    if(event.type==='source'){
      const task=cacheQueue.then(()=>saveSource(event,data)).catch(error=>log('cache-error',{error:error.message}));cacheQueue=task;
      pendingWrites.add(task);task.finally(()=>pendingWrites.delete(task));
    }else if(event.type.includes('error')||event.type==='metadata-not-found'||event.type==='download-requested'||event.type==='source-timeout')log(event.type,{key:event.assetKey||event.key,error:event.error,result:event.result});
  }else if(event.kind==='runtime-error')log('runtime-error',{error:event.error});
}
async function startRenderer(owner){
  const suffix=owner.replace(/[^0-9a-fx]/gi,'');
  const manifest=path.join(runtimeDir,'owner-'+suffix+'.json'),status=path.join(runtimeDir,'renderer-'+suffix+'.json');
  await atomic(manifest,{schemaVersion:1,ownerHwnd:owner,ownerProcessId:appPid,enabled:false,items:[]});
  const child=spawn(path.join(root,'renderer','InlineGifRenderer.exe'),['--manifest',manifest,'--status-file',status],{windowsHide:true,stdio:'ignore'});
  const entry={child,manifest,status,lastSeen:Date.now()};renderers.set(owner,entry);return entry;
}
async function publish(state){
  const present=new Set();
  for(const [owner,candidates]of Object.entries(state.owners||{})){
    const unique=new Map();
    for(const candidate of candidates){
      const asset=assets[candidate.assetKey];if(!asset||!/^[a-f0-9]{64}\.gif$/.test(asset.file))continue;
      const prior=unique.get(candidate.id);if(prior&&prior.lastPaint>=candidate.lastPaint)continue;
      unique.set(candidate.id,{...candidate,source:path.join(cacheDir,asset.file)});
    }
    const items=Array.from(unique.values()).slice(0,16);if(!items.length)continue;
    present.add(owner);let entry=renderers.get(owner);if(!entry||entry.child.exitCode!==null)entry=await startRenderer(owner);
    entry.lastSeen=Date.now();await atomic(entry.manifest,{schemaVersion:1,ownerHwnd:owner,ownerProcessId:appPid,enabled,items});
  }
  for(const [owner,entry]of renderers)if(!present.has(owner)){
    await atomic(entry.manifest,{schemaVersion:1,ownerHwnd:owner,ownerProcessId:appPid,enabled:false,items:[]});
    if(Date.now()-entry.lastSeen>15000){await atomic(entry.manifest,{schemaVersion:1,shutdown:true,items:[]});renderers.delete(owner);}
  }
}
async function cleanup(){
  for(const entry of renderers.values())try{await atomic(entry.manifest,{schemaVersion:1,shutdown:true,items:[]});}catch{}
  if(script&&!disconnected&&initialized){
    try{
      let status=await script.exports.shutdown();const deadline=Date.now()+6500;
      while(!status.canUnload&&Date.now()<deadline){await wait(100);status=(await script.exports.snapshot()).resolver;}
      if(!status.canUnload)throw new Error('Native source ownership cleanup is still pending');
      await script.exports.dispose();
    }catch(error){log('cleanup-error',{error:error.message});throw error;}
  }
  if(script&&!disconnected)await script.unload();
  if(session&&!disconnected)await session.detach();
  await Promise.allSettled(Array.from(pendingWrites));
  for(const entry of renderers.values()){if(entry.child.exitCode===null){await wait(150);if(entry.child.exitCode===null)entry.child.kill();}}
  renderers.clear();script=null;session=null;appPid=null;lastState=null;disconnected=false;initialized=false;
}
try{
  while(!stop){
    await readControl();if(stop)break;
    if(!session){
      const device=await frida.getLocalDevice();const processes=await device.enumerateProcesses();const app=processes.find(p=>p.name.toLowerCase()==='kakaotalk.exe');
      if(!app){await atomic(statePath,{state:'waiting-for-kakaotalk',enabled});await wait(1500);continue;}
      if(sha(await readFile(targetPath))!==supportedHash){await atomic(statePath,{state:'unsupported-version',enabled});await wait(5000);continue;}
      appPid=app.pid;disconnected=false;session=await frida.attach(appPid);
      session.detached.connect(()=>{disconnected=true;});
      const config={pid:appPid,testTitle:process.env.INLINEGIF_TEST_TITLE??'',setImageGuard:'558bec6aff68bd0e1d0264a100000000'};
      const files=['memory.js','native-abi.js','source-resolver.js','runtime.js'];
      const source='globalThis.INLINE_GIF_CONFIG='+JSON.stringify(config)+';\n'+(await Promise.all(files.map(f=>readFile(path.join(agentDir,f),'utf8')))).join('\n');
      script=await session.createScript(source);script.message.connect(onMessage);await script.load();initialized=true;
      await script.exports.setKnownAssets(Object.keys(assets));
      const startupResult=await script.exports.initialize();initialized=true;await atomic(path.join(runtimeDir,'startup.json'),startupResult);log('attached',{pid:appPid,...startupResult});
    }
    if(disconnected){await cleanup();await wait(1000);continue;}
    await script.exports.setEnabled(enabled);
    lastState=await script.exports.snapshot();await publish(lastState);
    await atomic(statePath,{state:'running',pid:appPid,enabled,owners:Object.keys(lastState.owners||{}),tracked:lastState.tracked,paintCount:lastState.paintCount,resolver:lastState.resolver,sourceErrors:lastState.sourceErrors,cachedAssets:Object.keys(assets).length});
    await wait(100);
  }
}catch(error){log('host-error',{error:error.stack||error.message});process.exitCode=1;}
finally{
  try{await cleanup();await atomic(statePath,{state:'stopped',enabled,clean:true});}
  catch(error){await atomic(statePath,{state:'cleanup-pending',enabled,error:error.message});process.exitCode=1;}
}

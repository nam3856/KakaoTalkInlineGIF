'use strict';
// App source calls are serialized on its real UI thread through DispatchMessageW.
// Native callbacks are never installed in a Windows timer or retained by the app.
const inspectionRpc=rpc.exports;
const runtimeState={running:false,enabled:true,stopping:false,lastPump:0,pumpBusy:false,paintCount:0,sourceErrors:0};
const uiThreads=new Set(),trackedWidgets=new Map(),thumbs=new Map(),sourceAssets=new Set(),allowedAssets=new Set(),listeners=[];
const postMessage=native('PostMessageW','int',['pointer','uint','pointer','pointer']);
let wakeHwnd=ptr(0),resolver=null,wakeTimer=null,scanPending=false;
let lastInvalidate=0;
const invalidate=native('InvalidateRect','int',['pointer','pointer','int']);
const gdi=Process.getModuleByName('gdi32.dll');
const gdiCall=(name,result,args)=>new NativeFunction(gdi.getExportByName(name),result,args,'stdcall');
const logicalToDevice=gdiCall('LPtoDP','int',['pointer','pointer','int']);
const dcOrigin=gdiCall('GetDCOrgEx','int',['pointer','pointer']);
const getClipBox=gdiCall('GetClipBox','int',['pointer','pointer']);
const windowFromDc=native('WindowFromDC','pointer',['pointer']);
const activePaints=new Map();let paintSequence=0;
function intersection(a,b){const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),bottom=Math.min(a.y+a.height,b.y+b.height);return{x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};}
function sourceSignature(w){return(w.source?.pieces||[]).map(p=>[p.gdip,p.memory,p.length,p.header].join(':')).join('|');}
function paintGeometry(w,args,gdiPaint){
  const origin=screenPoint(ptr(w.hwnd),0,0);if(!origin)return null;
  function transform(address){
    const r=rect(address),p=Memory.alloc(16);p.writeS32(r.left);p.add(4).writeS32(r.top);p.add(8).writeS32(r.right);p.add(12).writeS32(r.bottom);
    let dx=0,dy=0;
    if(gdiPaint){
      if(!logicalToDevice(args[0],p,2))return null;
      const dcWindow=windowFromDc(args[0]);
      if(!dcWindow.isNull()){
        if(!dcWindow.equals(ptr(w.hwnd)))return null;
        const d=Memory.alloc(8);if(!dcOrigin(args[0],d))return null;dx=d.readS32()-origin.x;dy=d.add(4).readS32()-origin.y;
      }
    }
    const t=rect(p);return{x:t.left+dx,y:t.top+dy,width:t.right-t.left,height:t.bottom-t.top};
  }
  const image=transform(args[1]);if(!image||image.width<1||image.height<1)return null;
  let clip={x:w.clipRect.x-origin.x,y:w.clipRect.y-origin.y,width:w.clipRect.width,height:w.clipRect.height};
  if(!args[2].isNull()){const supplied=transform(args[2]);if(!supplied)return null;clip=intersection(clip,supplied);}
  return{image,clip,raw:JSON.stringify(w.rect),wrapper:w.image};
}
function applyPaintGeometry(item,w){
  const geometry=item.paintGeometry;if(!geometry||geometry.wrapper!==w.image||geometry.raw!==JSON.stringify(w.rect))return false;
  const origin=screenPoint(ptr(w.hwnd),0,0);if(!origin)return false;
  w.imageRect={x:origin.x+geometry.image.x,y:origin.y+geometry.image.y,width:geometry.image.width,height:geometry.image.height};
  w.clipRect=intersection(w.clipRect,{x:origin.x+geometry.clip.x,y:origin.y+geometry.clip.y,width:geometry.clip.width,height:geometry.clip.height});return true;
}
function bytesHex(address,count){return Array.from(new Uint8Array(address.readByteArray(count)),b=>b.toString(16).padStart(2,'0')).join('');}
function guard(address,hex){const actual=bytesHex(address,hex.length/2);if(actual!==hex)throw new Error('Unsupported runtime bytes at '+address+' expected='+hex+' actual='+actual);}
function uriData(thumbnail){
  const data=thumbnail.add(0x50).readPointer(),length=data.sub(8).readU32();if(length<1||length>8192)throw new Error('Invalid media key');
  return new Uint8Array(data.readByteArray(length));
}
function identity(thumbnail){
  const chatId=thumbnail.add(0x30).readU64().toString(),logId=thumbnail.add(0x38).readU64().toString(),key=chatId+':'+logId;
  const bytes=uriData(thumbnail);let hash=0x811c9dc5;for(const b of bytes)hash=Math.imul(hash^b,0x01000193)>>>0;
  const uriFingerprint=hash.toString(16).padStart(8,'0');return{chatId,logId,key,uriFingerprint,assetKey:key+':'+uriFingerprint};
}
function registerUi(hwnd){
  if(!isWindow(hwnd))return;
  const pid=Memory.alloc(4),thread=getPid(hwnd,pid);if(pid.readU32()!==Process.id)return;
  if(uiThreads.size&&!uiThreads.has(thread))throw new Error('A second Kakao UI thread requires a separate resolver');
  uiThreads.add(thread);if(wakeHwnd.isNull()||!isWindow(wakeHwnd))wakeHwnd=hwnd;
}
function findMainUi(){
  const callback=new NativeCallback((h,u)=>{
    const pid=Memory.alloc(4),thread=getPid(h,pid);if(pid.readU32()!==Process.id)return 1;
    const b=Memory.alloc(1024);getText(h,b,512);
    if(isChatRoot(h)||b.readUtf16String()==='카카오톡'){
      if(!uiThreads.size||uiThreads.has(thread)){uiThreads.add(thread);if(wakeHwnd.isNull())wakeHwnd=h;}
    }
    return 1;
  },'int',['pointer','pointer'],'stdcall');
  enumWindows(callback,nullPtr);
}
function trackWidget(address,painted=false,args=null,gdiPaint=true){
  try{
    if(!address.readPointer().equals(widgetVt))return;
    const previous=trackedWidgets.get(address.toString());
    const w=widgetState(address);if(!w||!w.source?.pieces.length)return;
    registerUi(ptr(w.hwnd));
    if(!painted&&previous?.paintGeometry&&previous.lastImage===w.image&&previous.lastState?.hwnd===w.hwnd&&previous.paintGeometry.raw===JSON.stringify(w.rect)&&previous.sourceSignature===sourceSignature(w)){
      const thumb=thumbnailFor(w);if(thumb&&thumb.identity.assetKey===previous.assetKey){previous.lastState=w;applyPaintGeometry(previous,w);return;}
    }
    const item={address:address.toString(),lastPaint:painted?Date.now():0,lastState:w,lastImage:w.image,assetKey:null,identity:null,paintGeometry:painted&&args?paintGeometry(w,args,gdiPaint):null,paintEpoch:activePaints.get(w.hwnd)?.epoch||0};
    item.sourceSignature=sourceSignature(w);
    if(item.paintGeometry){applyPaintGeometry(item,w);const thumb=thumbnailFor(w);if(thumb){item.assetKey=thumb.identity.assetKey;item.identity=thumb.identity;}}
    trackedWidgets.set(address.toString(),item);
  }catch(_){}
}
function trackThumb(address){
  try{if(address.readPointer().equals(module.base.add(0x21b4160))&&address.add(0xc0).readU8())thumbs.set(address.toString(),{address:address.toString(),identity:identity(address)});}catch(_){}
}
function thumbnailFor(w){
  const gdips=new Set((w.source?.pieces||[]).map(p=>p.gdip));
  for(const [key,thumb]of thumbs){
    try{
      const p=ptr(thumb.address);if(!p.readPointer().equals(module.base.add(0x21b4160))||p.add(0xc0).readU8()===0){thumbs.delete(key);continue;}
      const current=identity(p);if(current.assetKey!==thumb.identity.assetKey){thumbs.delete(key);continue;}
      if(p.add(0x1c).readU8()===0&&gdips.has(p.add(0x18).readPointer().toString()))return thumb;
    }catch(_){thumbs.delete(key);}
  }
  return null;
}
function requestSource(thumb){
  if(!runtimeState.enabled||sourceAssets.has(thumb.identity.assetKey))return;
  const p=ptr(thumb.address),lo=p.add(0x38).readU32(),hi=p.add(0x3c).readU32();
  // The app returns an empty vector for IDs outside its media cache. Matching
  // the returned record's full chat/log/key identity remains mandatory.
  resolver.requestMessage({lo,hi},thumb.identity,uriData(p));
}
function uiPump(){
  if(runtimeState.pumpBusy)return;
  runtimeState.pumpBusy=true;
  try{
    if(runtimeState.stopping){resolver.stop();resolver.pump();return;}
    allowedAssets.clear();
    const viewports=new Set();
    for(const [key,item]of trackedWidgets){
      const w=widgetState(ptr(item.address));if(!w){trackedWidgets.delete(key);continue;}
      registerUi(ptr(w.hwnd));
      if(!w.source?.pieces.length){trackedWidgets.delete(key);continue;}
      item.assetKey=null;item.identity=null;item.lastImage=w.image;
      item.lastState=w;
      const painted=applyPaintGeometry(item,w)&&Date.now()-item.lastPaint<700;
      const r=w.imageRect,c=w.clipRect;
      const inViewport=c.width>0&&c.height>0&&r.x<c.x+c.width&&r.y<c.y+c.height&&r.x+r.width>c.x&&r.y+r.height>c.y;
      const thumb=thumbnailFor(w);
      if(thumb&&painted){
        item.assetKey=thumb.identity.assetKey;item.identity=thumb.identity;
        if(inViewport&&Date.now()-item.lastPaint<1500){allowedAssets.add(thumb.identity.assetKey);requestSource(thumb);}
      }
      viewports.add(w.hwnd);
    }
    if(Date.now()-lastInvalidate>100){for(const hwnd of viewports)invalidate(ptr(hwnd),nullPtr,0);lastInvalidate=Date.now();}
    resolver.pump();
  }catch(error){runtimeState.sourceErrors++;send({kind:'runtime-error',error:String(error)});}
  finally{runtimeState.pumpBusy=false;}
}
function startup(){
  findMainUi();
  const paint=module.base.add(0x1356330),paintAlt=module.base.add(0x1356b70),setImage=module.base.add(0x1355e60);
  guard(paint,'558bec6aff68911a290264a100000000');
  guard(paintAlt,'558bec83ec10538bd9568b7508578b4b');
  if(inlineConfig.setImageGuard)guard(setImage,inlineConfig.setImageGuard);
  const thumbGetEntry=module.base.add(0x21b4160).add(4).readPointer();
  if(!thumbGetEntry.equals(module.base.add(0xeb2fe0)))throw new Error('Thumbnail getter virtual slot changed');
  guard(thumbGetEntry,'558bec6aff68e6f9220264a100000000');
  const abi=createSourceResolverNativeAbi({moduleBase:module.base,pointerSize:4,verifyEntry:guard});
  resolver=createSourceResolver({moduleBase:module.base,pid:Process.id,abi,verifyEntry:guard,
    isUiThread:thread=>uiThreads.has(Number(thread)),isChatTarget:meta=>runtimeState.enabled&&allowedAssets.has(meta.assetKey||meta.key),
    win32:{globalSize,globalLock,globalUnlock},
    emit:(meta,binary)=>{if(meta.type==='source')sourceAssets.add(meta.assetKey);send({kind:'source-event',...meta},binary);}});
  resolver.start();
  for(const paintEntry of [paint,paintAlt])listeners.push(Interceptor.attach(paintEntry,{onEnter(args){
    if(runtimeState.stopping)return;
    runtimeState.paintCount++;trackWidget(this.context.ecx,true,args,paintEntry.equals(paint));
    if(uiThreads.has(this.threadId)&&Date.now()-runtimeState.lastPump>80){runtimeState.lastPump=Date.now();uiPump();}
  }}));
  listeners.push(Interceptor.attach(setImage,{onEnter(args){this.widget=this.context.ecx;},onLeave(){if(!runtimeState.stopping)trackWidget(this.widget);}}));
  listeners.push(Interceptor.attach(thumbGetEntry,{onEnter(){this.thumbnail=this.context.ecx;},onLeave(){if(!runtimeState.stopping)trackThumb(this.thumbnail);}}));
  listeners.push(Interceptor.attach(user.getExportByName('BeginPaint'),{onEnter(args){this.hwnd=args[0];this.paintStruct=args[1];},onLeave(hdc){
    if(!uiThreads.has(this.threadId))return;
    try{const h=this.hwnd.toString(),c=Memory.alloc(16),clip=Memory.alloc(16);if(!getClient(this.hwnd,c))return;const client=rect(c),dirty=rect(this.paintStruct.add(8));
      const kind=getClipBox(hdc,clip);let full=false;
      if(kind===2&&logicalToDevice(hdc,clip,2)){const bounds=rect(clip);full=bounds.left<=client.left&&bounds.top<=client.top&&bounds.right>=client.right&&bounds.bottom>=client.bottom;}
      activePaints.set(h,{epoch:++paintSequence,full:full&&dirty.left<=client.left&&dirty.top<=client.top&&dirty.right>=client.right&&dirty.bottom>=client.bottom});}catch(_){}
  }}));
  listeners.push(Interceptor.attach(user.getExportByName('EndPaint'),{onEnter(args){
    const hwnd=args[0].toString(),batch=activePaints.get(hwnd);if(!batch)return;
    if(batch.full)for(const item of trackedWidgets.values())if(item.lastState?.hwnd===hwnd&&item.paintEpoch!==batch.epoch){item.paintGeometry=null;item.assetKey=null;item.identity=null;}
    activePaints.delete(hwnd);
    if(uiThreads.has(this.threadId))uiPump();
  }}));
  listeners.push(Interceptor.attach(user.getExportByName('DispatchMessageW'),{onEnter(args){
    try{const msg=args[0],message=msg.add(4).readU32();if([0x20a,0x20e,0x114,0x115].includes(message)){
      const root=getParentRoot(msg.readPointer(),2).toString();for(const item of trackedWidgets.values())if(item.lastState?.rootHwnd===root){item.paintGeometry=null;item.assetKey=null;item.identity=null;}
    }}catch(_){}
    if(uiThreads.has(this.threadId)&&Date.now()-runtimeState.lastPump>80){runtimeState.lastPump=Date.now();uiPump();}
  }}));
  wakeTimer=setInterval(()=>{
    if(wakeHwnd.isNull()||!isWindow(wakeHwnd))findMainUi();
    if(!wakeHwnd.isNull()&&isWindow(wakeHwnd))postMessage(wakeHwnd,0,nullPtr,nullPtr);
  },100);
  runtimeState.running=true;
  return{ready:true,pid:Process.id,uiThreads:Array.from(uiThreads)};
}
const boot=startup();
rpc.exports={
  initialize(){
    const widgets=inspectionRpc.scanWidgets(536870912),containers=inspectionRpc.scanContainers(536870912);
    for(const c of containers.rows)if(c.kind==='thumbnail')trackThumb(ptr(c.self));
    for(const w of widgets.widgets)trackWidget(ptr(w.widget));
    return{...boot,widgets:trackedWidgets.size,thumbnails:thumbs.size,scan:{widgetRows:widgets.widgets.length,widgetBytes:widgets.bytesScanned,widgetCandidates:widgets.candidates,containerRows:containers.rows.length,containerBytes:containers.bytes},ranges:inspectionRpc.rangeSummary()};
  },
  setKnownAssets(keys){for(const key of keys)sourceAssets.add(String(key));},
  setEnabled(value){runtimeState.enabled=!!value;},
  snapshot(){
    const owners={};
    for(const item of trackedWidgets.values()){
      const w=item.lastState;if(!item.assetKey||!item.paintGeometry||Date.now()-item.lastPaint>700||!w||!w.visible||!(w.flags&0x200))continue;
      const r=w.imageRect,c=w.clipRect;
      if(c.width<=0||c.height<=0)continue;
      if(r.x>=c.x+c.width||r.y>=c.y+c.height||r.x+r.width<=c.x||r.y+r.height<=c.y)continue;
      const root=w.rootHwnd;(owners[root]??=[]).push({id:item.assetKey,assetKey:item.assetKey,widget:item.address,ownerHwnd:root,ownerProcessId:Process.id,imageRect:r,clipRect:c,lastPaint:item.lastPaint});
    }
    return{pid:Process.id,enabled:runtimeState.enabled,owners,tracked:trackedWidgets.size,paintCount:runtimeState.paintCount,resolver:resolver.status(),sourceErrors:runtimeState.sourceErrors};
  },
  shutdown(){runtimeState.stopping=true;runtimeState.enabled=false;resolver.stop();if(!wakeHwnd.isNull()&&isWindow(wakeHwnd))postMessage(wakeHwnd,0,nullPtr,nullPtr);return resolver.status();},
  dispose(){
    const status=resolver.status();if(!status.canUnload)throw new Error('Native source cleanup is not complete');
    if(wakeTimer!==null){clearInterval(wakeTimer);wakeTimer=null;}
    for(const listener of listeners)listener.detach();runtimeState.running=false;return{disposed:true};
  }
};
send({kind:'runtime-ready',...boot});

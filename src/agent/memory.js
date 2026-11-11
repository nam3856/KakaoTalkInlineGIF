'use strict';
const module = Process.getModuleByName('KakaoTalk.exe');
const inlineConfig=globalThis.INLINE_GIF_CONFIG||{};
if (Process.arch !== 'ia32' || !Number.isInteger(inlineConfig.pid) || Process.id !== inlineConfig.pid) throw new Error('Target identity changed');
const user = Process.getModuleByName('user32.dll');
const native = (name, result, args) => new NativeFunction(user.getExportByName(name), result, args, 'stdcall');
const isWindow = native('IsWindow', 'int', ['pointer']);
const isVisible = native('IsWindowVisible', 'int', ['pointer']);
const getParentRoot = native('GetAncestor', 'pointer', ['pointer','uint']);
const getPid = native('GetWindowThreadProcessId', 'uint', ['pointer','pointer']);
const getText = native('GetWindowTextW', 'int', ['pointer','pointer','int']);
const getClient = native('GetClientRect', 'int', ['pointer','pointer']);
const toScreen = native('ClientToScreen', 'int', ['pointer','pointer']);
const getClass = native('GetClassNameW', 'int', ['pointer','pointer','int']);
const enumWindows = native('EnumWindows', 'int', ['pointer','pointer']);
const enumChildren = native('EnumChildWindows', 'int', ['pointer','pointer','pointer']);
const nullPtr = ptr(0);
const kernel=Process.getModuleByName('kernel32.dll');
const globalLock=new NativeFunction(kernel.getExportByName('GlobalLock'),'pointer',['pointer'],'stdcall');
const globalUnlock=new NativeFunction(kernel.getExportByName('GlobalUnlock'),'int',['pointer'],'stdcall');
const globalSize=new NativeFunction(kernel.getExportByName('GlobalSize'),'uint',['pointer'],'stdcall');
const gdiplus=Process.getModuleByName('gdiplus.dll');
const getFrameCount=new NativeFunction(gdiplus.getExportByName('GdipImageGetFrameCount'),'int',['pointer','pointer','pointer'],'stdcall');
const timeGuid=Memory.alloc(16);timeGuid.writeByteArray([0x6d,0xbd,0xed,0x6a,0xb5,0x3f,0x8a,0x41,0x83,0xa6,0x7f,0x45,0x22,0x9d,0xc8,0x72]);
const widgetVt = module.base.add(0x20edc6c);
const targetTitle = inlineConfig.testTitle || ''; // Optional developer filter; no personal chat name is built in.
const chatRootCache=new Map();
function isChatRoot(root){
  try{
    if(!isWindow(root))return false;
    const cached=chatRootCache.get(root.toString());if(cached&&Date.now()-cached.time<1000)return cached.value;
    const pid=Memory.alloc(4);getPid(root,pid);if(pid.readU32()!==Process.id)return false;
    const title=Memory.alloc(1024);getText(root,title,512);
    if(targetTitle&&title.readUtf16String()!==targetTitle)return false;
    let hasInput=false;
    const child=new NativeCallback((h,u)=>{const b=Memory.alloc(512);getClass(h,b,256);if(b.readUtf16String().startsWith('RICHEDIT'))hasInput=true;return 1;},'int',['pointer','pointer'],'stdcall');
    enumChildren(root,child,nullPtr);chatRootCache.set(root.toString(),{time:Date.now(),value:hasInput});return hasInput;
  }catch(_){return false;}
}
function readPtr(p) { try { return p.readPointer(); } catch (_) { return null; } }
function readU32(p) { try { return p.readU32(); } catch (_) { return null; } }
function typeName(p) {
  try {
    const vt = p.readPointer();
    if (vt.compare(module.base)<0 || vt.compare(module.base.add(module.size))>=0) return null;
    return vt.sub(4).readPointer().add(12).readPointer().add(8).readCString();
  } catch (_) { return null; }
}
function rect(p) { return {left:p.readS32(),top:p.add(4).readS32(),right:p.add(8).readS32(),bottom:p.add(12).readS32()}; }
function screenPoint(hwnd,x,y) {
  const p=Memory.alloc(8);p.writeS32(x);p.add(4).writeS32(y);
  if (!toScreen(hwnd,p)) return null;
  return {x:p.readS32(),y:p.add(4).readS32()};
}
function sourceState(image) {
  try {
    if(!image.readPointer().equals(module.base.add(0x20bedc8)))return null;
    const begin=image.add(0x3c).readPointer(),end=image.add(0x40).readPointer();
    const count=end.sub(begin).toInt32()/4;if(count<1||count>64||!Number.isInteger(count))return null;
    const pieces=[];
    for(let i=0;i<count;i++){
      const piece=begin.add(i*4).readPointer();if(piece.isNull()||!piece.readPointer().equals(module.base.add(0x22247a8)))continue;
      const gdip=piece.add(0xc).readPointer();if(gdip.isNull()||!gdip.readPointer().equals(module.base.add(0x22242c4)))continue;
      const memory=gdip.add(0x18).readPointer();if(memory.isNull()||!memory.readPointer().equals(module.base.add(0x22832dc)))continue;
      const length=memory.add(0xc).readU32(),buffer=memory.add(0x10).readPointer();
      let header=null;
      if(length>=8&&length<67108864){
        if(!buffer.isNull())header=Array.from(new Uint8Array(buffer.readByteArray(8)),b=>b.toString(16).padStart(2,'0')).join('');
        else {
          const handle=memory.add(8).readPointer();
          if(!handle.isNull()&&globalSize(handle)>=length){
            const locked=globalLock(handle);
            if(!locked.isNull())try{header=Array.from(new Uint8Array(locked.readByteArray(8)),b=>b.toString(16).padStart(2,'0')).join('');}finally{globalUnlock(handle);}
          }
        }
      }
      let gpImage=null,frames=null,frameStatus=null;
      if(inlineConfig.inspectFrames===true)try{
        const impl=gdip.add(0x10).readPointer(),wrapper=impl.readPointer(),nativeImage=wrapper.add(4).readPointer();
        const count=Memory.alloc(4);frameStatus=getFrameCount(nativeImage,timeGuid,count);
        if(frameStatus===0){gpImage=nativeImage.toString();frames=count.readU32();}
      }catch(_){}
      pieces.push({piece:piece.toString(),gdip:gdip.toString(),memory:memory.toString(),length,buffer:buffer.toString(),header,gpImage,frames,frameStatus});
    }
    return {count,pieces};
  }catch(error){return {error:String(error)};}
}
function widgetState(p) {
  try {
    if (!p.readPointer().equals(widgetVt)) return null;
    const owner=p.add(0x10).readPointer();
    if (owner.isNull()) return null;
    const hwnd=owner.add(0x1c).readPointer();
    if (!isWindow(hwnd)) return null;
    const pid=Memory.alloc(4);getPid(hwnd,pid);
    if (pid.readU32()!==Process.id) return null;
    const root=getParentRoot(hwnd,2);
    const title=Memory.alloc(1024);getText(root,title,512);
    if (!isChatRoot(root)) return null;
    const r=rect(p.add(0x44));
    const width=r.right-r.left,height=r.bottom-r.top;
    if (width<24||height<24||width>4096||height>4096||Math.abs(r.left)>20000||Math.abs(r.top)>20000) return null;
    const origin=screenPoint(hwnd,r.left,r.top);
    const clip=Memory.alloc(16);if(!getClient(hwnd,clip))return null;
    const cr=rect(clip),co=screenPoint(hwnd,cr.left,cr.top);
    const image=p.add(0xe0).readPointer();
    const fields={};
    if(inlineConfig.inspectDetails===true&&!image.isNull()) for(let offset=0;offset<0x48;offset+=4)fields['0x'+offset.toString(16)]=readPtr(image.add(offset))?.toString()||null;
    const ancestors=[];let ancestor=p.add(0x14).readPointer();const seen=new Set();
    while(inlineConfig.inspectDetails===true&&!ancestor.isNull()&&ancestors.length<16&&!seen.has(ancestor.toString())){
      seen.add(ancestor.toString());ancestors.push({pointer:ancestor.toString(),type:typeName(ancestor),flags:readU32(ancestor.add(0x94))});
      const next=readPtr(ancestor.add(0x14));if(next===null)break;ancestor=next;
    }
    return {widget:p.toString(),owner:owner.toString(),hwnd:hwnd.toString(),rootHwnd:root.toString(),ancestors,
      visible:!!isVisible(hwnd),flags:readU32(p.add(0x94)),rect:r,
      imageRect:{...origin,width,height},clipRect:{...co,width:cr.right-cr.left,height:cr.bottom-cr.top},
      image:image.toString(),imageType:image.isNull()?null:typeName(image),imageFields:fields,
      source:image.isNull()?null:sourceState(image),
      animation:p.add(0x130).readPointer().toString(),animationFields:inlineConfig.inspectDetails===true?Array.from({length:8},(_,i)=>readU32(p.add(0x130).readPointer().add(i*4))):[]};
  } catch (_) { return null; }
}
rpc.exports = {
  scanContentLinks(maxBytes=268435456) {
    maxBytes=Number(maxBytes)||268435456;const links=[];let bytes=0,contents=0;
    const vt=module.base.add(0x21ab29c),pattern=Array.from(new Uint8Array(new Uint32Array([vt.toUInt32()]).buffer),b=>b.toString(16).padStart(2,'0')).join(' ');
    for(const range of Process.enumerateRanges({protection:'rw-',coalesce:true})){
      if(range.file)continue;
      for(let o=0;o<range.size&&bytes<maxBytes;o+=4194304){
        const size=Math.min(4194304,range.size-o,maxBytes-bytes);bytes+=size;let hits=[];
        try{hits=Memory.scanSync(range.base.add(o),size,pattern);}catch(_){}
        for(const hit of hits)try{
          const p=hit.address,head=p.add(0x284).readPointer(),count=p.add(0x288).readU32();
          if(head.isNull()||count<1||count>64||head.add(0xd).readU8()!==1)continue;
          contents++;const stack=[head.add(4).readPointer()],seen=new Set();
          while(stack.length&&seen.size<count+2){
            const node=stack.pop();if(node.isNull()||node.equals(head)||seen.has(node.toString()))continue;
            seen.add(node.toString());if(node.add(0xd).readU8()!==0)continue;
            const widget=node.add(0x2c).readPointer(),state=widgetState(widget);
            if(state)links.push({content:p.toString(),node:node.toString(),widget:widget.toString(),messageLo:p.add(0x38).readU32(),messageHi:p.add(0x3c).readU32(),nodeGifFlag:node.add(0x61).readU8(),variantImage:node.add(0x48).readPointer().toString(),variantTag:node.add(0x4c).readU8()});
            stack.push(node.readPointer(),node.add(8).readPointer());
          }
        }catch(_){}
      }
      if(bytes>=maxBytes)break;
    }
    return{contents,links};
  },
  refreshWidgets(addresses) {
    if(!Array.isArray(addresses)||addresses.length>256)throw new Error('Invalid widget set');
    return addresses.map(a=>widgetState(ptr(a))).filter(Boolean);
  },
  readContainerGif(address) {
    const c=ptr(address);if(!c.readPointer().equals(module.base.add(0x21b419c)))throw new Error('Invalid original container');
    if(c.add(0x1c).readU8()!==0)throw new Error('Unsupported original image kind');
    const image=c.add(0x18).readPointer();if(image.isNull()||!image.readPointer().equals(module.base.add(0x22242c4)))throw new Error('Original image not ready');
    const memory=image.add(0x18).readPointer();if(!memory.readPointer().equals(module.base.add(0x22832dc)))throw new Error('Original memory type changed');
    const length=memory.add(0xc).readU32(),handle=memory.add(8).readPointer();
    if(length<8||length>16777216||globalSize(handle)<length)throw new Error('Invalid GIF buffer length');
    const buffer=globalLock(handle);if(buffer.isNull())throw new Error('GIF buffer unavailable');
    try{const magic=buffer.readUtf8String(6);if(magic!=='GIF89a'&&magic!=='GIF87a')throw new Error('Not a GIF');return buffer.readByteArray(length);}finally{globalUnlock(handle);}
  },
  scanContainers(maxBytes=268435456) {
    maxBytes=Number(maxBytes)||268435456;
    const kinds=[{name:'original',rva:0x21b419c,log:0x30,chat:0x28,key:0x48},{name:'thumbnail',rva:0x21b4160,log:0x38,chat:0x30,key:0x50}];
    const rows=[];let bytes=0;
    function stringValue(p){try{const n=p.sub(8).readU32();return n<4096?p.readUtf8String(n):null;}catch(_){return null;}}
    for(const range of Process.enumerateRanges({protection:'rw-',coalesce:true})){
      if(range.file)continue;
      for(let o=0;o<range.size&&bytes<maxBytes;o+=4194304){
        const size=Math.min(4194304,range.size-o,maxBytes-bytes);bytes+=size;
        for(const kind of kinds){
          const vt=module.base.add(kind.rva),pattern=Array.from(new Uint8Array(new Uint32Array([vt.toUInt32()]).buffer),b=>b.toString(16).padStart(2,'0')).join(' ');
          let hits=[];try{hits=Memory.scanSync(range.base.add(o),size,pattern);}catch(_){}
          for(const hit of hits)try{
            const p=hit.address,tag=p.add(0x1c).readU8(),image=p.add(0x18).readPointer();if(tag>1&&tag!==255)continue;
            const log=p.add(kind.log).readU64().toString(),chat=p.add(kind.chat).readU64().toString();if(log==='0')continue;
            const key=stringValue(p.add(kind.key).readPointer());let source=null;
            if(tag===0&&!image.isNull()&&image.readPointer().equals(module.base.add(0x22242c4))){
              const mem=image.add(0x18).readPointer();
              if(!mem.isNull()&&mem.readPointer().equals(module.base.add(0x22832dc))){
                const length=mem.add(0xc).readU32(),handle=mem.add(8).readPointer();let magic=null;
                if(length>=8&&length<67108864&&globalSize(handle)>=length){const data=globalLock(handle);if(!data.isNull())try{magic=Array.from(new Uint8Array(data.readByteArray(8)),b=>b.toString(16).padStart(2,'0')).join('');}finally{globalUnlock(handle);}}
                source={memory:mem.toString(),length,magic};
              }
            }
            rows.push({kind:kind.name,self:p.toString(),logId:log,chatId:chat,key,image:image.toString(),tag,source});
          }catch(_){}
        }
      }
      if(bytes>=maxBytes)break;
    }
    return{bytes,rows};
  },
  readWidgetGif(address) {
    const w=ptr(address),state=widgetState(w);if(!state)throw new Error('Invalid target widget');
    const piece=state.source?.pieces.find(p=>p.header?.startsWith('474946383761')||p.header?.startsWith('474946383961'));
    if(!piece||piece.length>16777216)throw new Error('No bounded original GIF found');
    const memory=ptr(piece.memory),handle=memory.add(8).readPointer();
    if(globalSize(handle)<piece.length)throw new Error('Global memory length changed');
    const locked=globalLock(handle);if(locked.isNull())throw new Error('Global memory lock failed');
    try{return locked.readByteArray(piece.length);}finally{globalUnlock(handle);}
  },
  windowSummary() {
    const rows=[];
    const collect=new NativeCallback((hwnd,unused)=>{
      const pid=Memory.alloc(4);getPid(hwnd,pid);if(pid.readU32()!==Process.id)return 1;
      const title=Memory.alloc(1024);getText(hwnd,title,512);
      if(title.readUtf16String()!==targetTitle)return 1;
      const cl=Memory.alloc(512);getClass(hwnd,cl,256);const children=[];
      const child=new NativeCallback((h,u)=>{const c=Memory.alloc(512);getClass(h,c,256);children.push(c.readUtf16String());return 1;},'int',['pointer','pointer'],'stdcall');
      enumChildren(hwnd,child,nullPtr);
      rows.push({hwnd:hwnd.toString(),className:cl.readUtf16String(),children});return 1;
    },'int',['pointer','pointer'],'stdcall');
    enumWindows(collect,nullPtr);return rows;
  },
  rangeSummary() {
    const ranges=Process.enumerateRanges({protection:'rw-',coalesce:true});
    return {count:ranges.length,first:ranges.slice(0,12).map(r=>({base:r.base.toString(),size:r.size,protection:r.protection,file:!!r.file})),allCount:Process.enumerateRanges('---').length};
  },
  scanWidgets(maxBytes=201326592) {
    maxBytes=Number(maxBytes)||201326592;
    const pattern=Array.from(new Uint8Array(widgetVt.toUInt32()===0?new ArrayBuffer(4):new Uint32Array([widgetVt.toUInt32()]).buffer),b=>b.toString(16).padStart(2,'0')).join(' ');
    const results=[];let bytes=0,ranges=0,candidates=0;
    for(const range of Process.enumerateRanges({protection:'rw-',coalesce:true})) {
      if(range.file)continue;
      for(let offset=0;offset<range.size && bytes<maxBytes;offset+=4194304) {
        const size=Math.min(4194304,range.size-offset,maxBytes-bytes);if(size<4)break;
        let hits=[];try{hits=Memory.scanSync(range.base.add(offset),size,pattern);}catch(_){}
        bytes+=size;ranges++;
        for(const hit of hits){candidates++;const state=widgetState(hit.address);if(state)results.push(state);if(results.length>=100)break;}
        if(results.length>=100)break;
      }
      if(bytes>=maxBytes||results.length>=100)break;
    }
    return {pid:Process.id,moduleBase:module.base.toString(),bytesScanned:bytes,chunks:ranges,candidates,widgets:results,
      api:{InvalidateRect:user.getExportByName('InvalidateRect').toString()},limitations:['Read-only heap pointer search; stale allocation candidates rejected by type, HWND, PID and target title guards.']};
  },
  instructions(rva,count=40) {
    const allowed=[0x1355e60,0xe594b0,0xeb13d0,0xeb4840];
    if(!allowed.includes(rva)||count>80)throw new Error('Unregistered instruction probe');
    let p=module.base.add(rva);const out=[];
    for(let i=0;i<count;i++){const instruction=Instruction.parse(p);out.push({address:p.toString(),text:instruction.toString()});p=instruction.next;}
    return out;
  }
};
send({kind:'ready',pid:Process.id,moduleBase:module.base.toString()});

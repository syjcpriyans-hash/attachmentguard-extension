import { init } from "@embedpdf/pdfium";
import opentype from "opentype.js";
import { vaultCount, vaultList, vaultPut } from "./font-vault.js";
import { segmentWords, planWordReplacement, KernelError } from "./text-kernel.js";

const WASM_URL = chrome.runtime.getURL("assets/pdfium.wasm");
const TEXT = 1, FONT_TRUETYPE = 2, FONT_TYPE1 = 1;
const $ = id => document.getElementById(id);
const subsetRx = /^[A-Z]{6}\+/;
const stripSubset = s => (s||"").replace(subsetRx,"");
const norm = s => stripSubset(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"");
const codepoints = s => Array.from(s);
const cpLabel = ch => `${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")})`;

const S = {
  m:null, bytes:null, originalBytes:null, doc:0, ptr:0, pages:0, name:"document.pdf",
  originalUrl:"", tabId:null, zoom:1, fitScale:1, editMode:false, dirty:false,
  pageMetrics:[], history:[], currentPage:0, inline:null, pendingFont:null, resolvedFont:null, commitBusy:false, filenameOriginal:"", kernels:new Map()
};

function rt(){
  const p=S.m.pdfium;
  return {
    malloc:n=>{const x=p.wasmExports.malloc(n);if(!x&&n)throw Error("PDFium out of memory");return x},
    free:x=>x&&p.wasmExports.free(x),heap:()=>p.HEAPU8,gf:x=>p.getValue(x,"float"),
    gi:x=>p.getValue(x,"i32"),gd:x=>p.getValue(x,"double"),sf:(p2,v)=>p.setValue(p2,v,"float"),
    u16:x=>p.UTF16ToString(x),u8:x=>p.UTF8ToString(x),w16:(s,p2,n)=>p.stringToUTF16(s,p2,n)
  };
}
function toast(text,kind="ok"){
  const e=$("toast");e.textContent=text;e.className=`toast ${kind} show`;
  clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("show"),2600);
}
function loading(text){$("loadingText").textContent=text}
function closeDoc(){
  if(!S.m)return;const r=rt();
  try{if(S.doc)S.m.FPDF_CloseDocument(S.doc)}catch{}
  try{if(S.ptr)r.free(S.ptr)}catch{}
  S.doc=0;S.ptr=0
}
function openBytes(bytes){
  closeDoc();const r=rt(),p=r.malloc(bytes.length);r.heap().set(bytes,p);
  const d=S.m.FPDF_LoadMemDocument(p,bytes.length,0);
  if(!d){r.free(p);throw Error(`PDFium could not open PDF. Error ${S.m.FPDF_GetLastError()}`)}
  S.bytes=bytes;S.ptr=p;S.doc=d;S.pages=S.m.FPDF_GetPageCount(d)
}
function cstr(fn,h){
  if(!h)return"";const n=fn(h,0,0);if(!n)return"";
  const r=rt(),p=r.malloc(n);try{fn(h,p,n);return r.u8(p)}finally{r.free(p)}
}
function readMatrix(o){
  const r=rt(),p=r.malloc(24);try{
    if(!S.m.FPDFPageObj_GetMatrix(o,p))return[1,0,0,1,0,0];
    return[0,4,8,12,16,20].map(k=>r.gf(p+k))
  }finally{r.free(p)}
}
function writeMatrix(o,m){
  const r=rt(),p=r.malloc(24);try{
    m.forEach((v,i)=>r.sf(p+i*4,v));
    if(!S.m.FPDFPageObj_SetMatrix(o,p))throw Error("Could not preserve transform matrix")
  }finally{r.free(p)}
}
function readRGBA(fn,o,def=[0,0,0,255]){
  const r=rt(),p=r.malloc(16);try{return fn(o,p,p+4,p+8,p+12)?[0,4,8,12].map(x=>r.gi(p+x)):def}finally{r.free(p)}
}
function readFloatProp(fn,o,def=0){
  const r=rt(),p=r.malloc(4);try{return fn(o,p)?r.gf(p):def}finally{r.free(p)}
}
function readBounds(o){
  const r=rt(),p=r.malloc(16);try{
    if(!S.m.FPDFPageObj_GetBounds(o,p,p+4,p+8,p+12))return null;
    return{left:r.gf(p),bottom:r.gf(p+4),right:r.gf(p+8),top:r.gf(p+12)}
  }finally{r.free(p)}
}
function readText(o,tp){
  const n=S.m.FPDFTextObj_GetText(o,tp,0,0);if(n<=0)return"";
  const r=rt(),p=r.malloc(n*2);try{S.m.FPDFTextObj_GetText(o,tp,p,n);return r.u16(p).replace(/\0/g,"")}finally{r.free(p)}
}
function fontData(font){
  if(!font)return null;const r=rt(),out=r.malloc(4);
  try{
    if(!S.m.FPDFFont_GetFontData(font,0,0,out))return null;
    const size=r.gi(out)>>>0;if(!size||size>100_000_000)return null;
    const p=r.malloc(size);try{
      if(!S.m.FPDFFont_GetFontData(font,p,size,out))return null;
      const actual=r.gi(out)>>>0;if(!actual||actual>size)return null;
      return r.heap().slice(p,p+actual)
    }finally{r.free(p)}
  }finally{r.free(out)}
}
function parseFont(bytes){
  if(!bytes||bytes.length<4)return{ok:false,error:"No parseable font data"};
  try{
    const ab=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    return{ok:true,font:opentype.parse(ab),bytes}
  }catch(e){return{ok:false,error:e.message}}
}
function glyphMissing(parsed,text){
  if(!parsed?.ok)return[];
  const out=[];for(const ch of codepoints(text)){if(/\s/.test(ch))continue;if(!parsed.font.charToGlyphIndex(ch))out.push(ch)}
  return[...new Set(out)]
}
function fsTypeInfo(parsed){
  const fs=parsed?.ok?Number(parsed.font?.tables?.os2?.fsType??0):null;
  if(fs===null)return{allowed:false,text:"Embedding rights unknown"};
  const usage=fs&0x000F,noSubset=!!(fs&0x0100),bitmapOnly=!!(fs&0x0200);
  let allowed=false,text="";
  if(bitmapOnly)text="Bitmap-only embedding";
  else if(usage===0){allowed=true;text="Installable embedding allowed"}
  else if(usage&0x0008){allowed=true;text="Editable embedding allowed"}
  else if(usage&0x0004)text="Preview & Print embedding only";
  else if(usage&0x0002)text="Restricted License embedding";
  else text="Unknown/restricted embedding";
  if(noSubset){allowed=false;text+="; No Subsetting flag set"}
  return{allowed,fsType:fs,text}
}
function readStyle(o){
  const font=S.m.FPDFTextObj_GetFont(o),size=readFloatProp(S.m.FPDFTextObj_GetFontSize,o,0);
  let angle=0;try{const r=rt(),p=r.malloc(4);try{if(font&&S.m.FPDFFont_GetItalicAngle(font,p))angle=r.gi(p)}finally{r.free(p)}}catch{}
  return{
    fontName:cstr(S.m.FPDFFont_GetBaseFontName,font),family:cstr(S.m.FPDFFont_GetFamilyName,font),
    size,weight:font?S.m.FPDFFont_GetWeight(font):-1,italic:angle,embedded:font?S.m.FPDFFont_GetIsEmbedded(font):-1,font,
    fill:readRGBA(S.m.FPDFPageObj_GetFillColor,o),stroke:readRGBA(S.m.FPDFPageObj_GetStrokeColor,o),
    strokeWidth:readFloatProp(S.m.FPDFPageObj_GetStrokeWidth,o,0),matrix:readMatrix(o),
    render:S.m.FPDFTextObj_GetTextRenderMode(o),transparency:!!S.m.FPDFPageObj_HasTransparency(o)
  }
}
function styleIdentity(s){
  const base=stripSubset(s.fontName),family=stripSubset(s.family),nm=(base+" "+family).toLowerCase();
  return{base,family,bold:/bold|black|heavy|semibold|demibold/.test(nm),slanted:s.italic!==0||/italic|oblique/.test(nm)}
}
function sameIdentity(a,b){
  const aa=styleIdentity(a),bb=styleIdentity(b);
  if(norm(aa.base)===norm(bb.base))return true;
  return norm(aa.family)===norm(bb.family)&&aa.bold===bb.bold&&aa.slanted===bb.slanted
}
function listObjects(doc,pageIndex){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)return[];
  const tp=S.m.FPDFText_LoadPage(page),out=[],count=S.m.FPDFPage_CountObjects(page);
  try{
    for(let i=0;i<count;i++){
      const o=S.m.FPDFPage_GetObject(page,i);if(S.m.FPDFPageObj_GetType(o)!==TEXT)continue;
      const b=readBounds(o);if(!b)continue;const t=readText(o,tp);if(!t.trim())continue;
      out.push({page:pageIndex,index:i,text:t,bounds:b,style:readStyle(o)})
    }
    return out
  }finally{S.m.FPDFText_ClosePage(tp);S.m.FPDF_ClosePage(page)}
}

function colorEq(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function linearMatrixEq(a,b){return[0,1,2,3].every(i=>Math.abs((a?.[i]??0)-(b?.[i]??0))<0.001)}
function sameVisualStyle(a,b){
  return sameIdentity(a,b)&&Math.abs(a.size-b.size)<0.2&&a.render===b.render
    &&Math.abs(a.strokeWidth-b.strokeWidth)<0.05&&colorEq(a.fill,b.fill)&&colorEq(a.stroke,b.stroke)
    &&linearMatrixEq(a.matrix,b.matrix)
}
function styleKey(s){
  const m=s.matrix||[1,0,0,1,0,0];
  return [
    norm(s.fontName),norm(s.family),Number(s.size).toFixed(2),s.weight,s.italic,s.render,
    JSON.stringify(s.fill),JSON.stringify(s.stroke),Number(s.strokeWidth).toFixed(3),
    ...m.slice(0,4).map(v=>Number(v).toFixed(4))
  ].join("|")
}
function readCharBox(tp,index){
  const r=rt(),p=r.malloc(32);
  try{
    if(!S.m.FPDFText_GetCharBox(tp,index,p,p+8,p+16,p+24))return null;
    return{left:r.gd(p),right:r.gd(p+8),bottom:r.gd(p+16),top:r.gd(p+24)}
  }finally{r.free(p)}
}
function readCharOrigin(tp,index){
  const r=rt(),p=r.malloc(16);
  try{
    if(!S.m.FPDFText_GetCharOrigin(tp,index,p,p+8))return null;
    return{x:r.gd(p),y:r.gd(p+8)}
  }finally{r.free(p)}
}

function buildPageKernel(doc,pageIndex){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)return{characters:[],words:[],objects:new Map()};
  const tp=S.m.FPDFText_LoadPage(page),objects=new Map(),handleToIndex=new Map();
  try{
    const objectCount=S.m.FPDFPage_CountObjects(page);
    for(let i=0;i<objectCount;i++){
      const obj=S.m.FPDFPage_GetObject(page,i);
      if(!obj||S.m.FPDFPageObj_GetType(obj)!==TEXT)continue;
      handleToIndex.set(obj,i);
      const style=readStyle(obj),text=readText(obj,tp),cp=Array.from(text);
      objects.set(i,{index:i,handle:obj,text,style,bounds:readBounds(obj)})
    }

    const offsets=new Map(),characters=[],count=S.m.FPDFText_CountChars(tp);
    for(let i=0;i<count;i++){
      const cp=S.m.FPDFText_GetUnicode(tp,i);
      const unicode=cp?String.fromCodePoint(cp):"";
      const obj=S.m.FPDFText_GetTextObject(tp,i);
      const objIndex=obj?handleToIndex.get(obj):null;
      let objOffset=null;
      if(objIndex!=null){
        objOffset=offsets.get(objIndex)||0;
        offsets.set(objIndex,objOffset+1)
      }
      const box=readCharBox(tp,i);
      const origin=readCharOrigin(tp,i);
      const rec=objIndex!=null?objects.get(objIndex):null;
      const generated=typeof S.m.FPDFText_IsGenerated==="function"?S.m.FPDFText_IsGenerated(tp,i)===1:false;
      const mapError=typeof S.m.FPDFText_HasUnicodeMapError==="function"?S.m.FPDFText_HasUnicodeMapError(tp,i):0;
      const angle=typeof S.m.FPDFText_GetCharAngle==="function"?S.m.FPDFText_GetCharAngle(tp,i):0;
      if(!box||!origin)continue;
      const ch={
        streamIndex:i,unicode,objIndex,objOffset,generated,mapError,angle,
        fontSize:S.m.FPDFText_GetFontSize(tp,i),box,origin,
        styleKey:rec?styleKey(rec.style):""
      };
      characters.push(ch);
    }


    const words=segmentWords(characters).map(word=>{
      const firstSlice=word.slices[0],rec=firstSlice?objects.get(firstSlice.objIndex):null;
      return{...word,page:pageIndex,style:rec?.style||null,objectRecords:objects}
    });
    return{characters,words,objects}
  }finally{
    S.m.FPDFText_ClosePage(tp);S.m.FPDF_ClosePage(page)
  }
}

function fontFingerprint(font){
  const bytes=fontData(font);if(!bytes)return"no-font-data";
  let h=2166136261,step=Math.max(1,Math.floor(bytes.length/8192));
  for(let i=0;i<bytes.length;i+=step){h^=bytes[i];h=Math.imul(h,16777619)}
  return`${(h>>>0).toString(16)}-${bytes.length}`
}
function pdfNativeRepertoire(style){
  const target=fontFingerprint(style.font),chars=new Map(),cache=new Map();
  for(let pi=0;pi<S.pages;pi++){
    const page=S.m.FPDF_LoadPage(S.doc,pi);if(!page)continue;
    const tp=S.m.FPDFText_LoadPage(page);
    try{
      const n=S.m.FPDFText_CountChars(tp);
      for(let i=0;i<n;i++){
        const obj=S.m.FPDFText_GetTextObject(tp,i);if(!obj||S.m.FPDFPageObj_GetType(obj)!==TEXT)continue;
        const font=S.m.FPDFTextObj_GetFont(obj);let key=cache.get(font);
        if(!key){key=fontFingerprint(font);cache.set(font,key)}
        if(key!==target)continue;
        const cp=S.m.FPDFText_GetUnicode(tp,i);
        const err=typeof S.m.FPDFText_HasUnicodeMapError==="function"?S.m.FPDFText_HasUnicodeMapError(tp,i):0;
        if(cp&&err===0){const ch=String.fromCodePoint(cp);if(!/\s/.test(ch))chars.set(ch,(chars.get(ch)||0)+1)}
      }
    }finally{S.m.FPDFText_ClosePage(tp);S.m.FPDF_ClosePage(page)}
  }
  return chars
}
function embeddedPreflight(selected,text){
  const bytes=fontData(selected.style.font),parsed=parseFont(bytes),rep=pdfNativeRepertoire(selected.style);
  const required=[...new Set(Array.from(text).filter(ch=>!/\s/.test(ch)))];
  const missing=[];
  for(const ch of required){
    if(rep.has(ch))continue;
    if(parsed.ok&&!glyphMissing(parsed,ch).length)continue;
    missing.push(ch)
  }
  return{bytes,parsed,missing}
}
function fontMatchUploaded(parsed,orig){
  if(!parsed.ok)return false;
  const ps=parsed.font.names?.postScriptName?.en||"",fam=parsed.font.names?.fontFamily?.en||"",sub=parsed.font.names?.fontSubfamily?.en||"";
  const target=styleIdentity(orig),cand=(ps+" "+fam+" "+sub).toLowerCase();
  const bold=/bold|black|heavy|semibold|demibold/.test(cand),slanted=/italic|oblique/.test(cand);
  return(norm(ps)===norm(target.base)||norm(fam)===norm(target.family)||norm(fam)===norm(target.base))&&bold===target.bold&&slanted===target.slanted
}
function fontVaultId(bytes){
  let h=2166136261,step=Math.max(1,Math.floor(bytes.length/4096));
  for(let i=0;i<bytes.length;i+=step){h^=bytes[i];h=Math.imul(h,16777619)}
  return`font-${(h>>>0).toString(16)}-${bytes.length}`
}
function validateFontBytes(bytes,orig,newText,source){
  const parsed=parseFont(bytes);if(!parsed.ok)return{ok:false,reason:parsed.error};
  if(!fontMatchUploaded(parsed,orig))return{ok:false,reason:`${source} font does not exactly match ${stripSubset(orig.fontName)}`};
  const missing=glyphMissing(parsed,newText);if(missing.length)return{ok:false,reason:`Font is missing ${missing.map(cpLabel).join(", ")}`};
  const rights=fsTypeInfo(parsed);if(!rights.allowed)return{ok:false,reason:`Embedding permission blocks editing: ${rights.text}`};
  const names={family:parsed.font.names?.fontFamily?.en||"",postscript:parsed.font.names?.postScriptName?.en||"",subfamily:parsed.font.names?.fontSubfamily?.en||""};
  return{ok:true,source,bytes,parsed,rights,id:fontVaultId(bytes),names}
}
async function rememberFont(v){
  if(!v?.ok)return;
  await vaultPut({id:v.id,names:v.names,source:v.source,savedAt:Date.now(),bytes:v.bytes.buffer.slice(v.bytes.byteOffset,v.bytes.byteOffset+v.bytes.byteLength)})
}
async function findInVault(orig,text){
  try{
    for(const e of await vaultList()){
      const v=validateFontBytes(new Uint8Array(e.bytes),orig,text,"Font Vault");if(v.ok)return v
    }
  }catch{}
  return null
}
function findInPdf(orig,text){
  for(let pi=0;pi<S.pages;pi++){
    for(const cand of listObjects(S.doc,pi)){
      if(cand.style.embedded!==1||!sameIdentity(orig,cand.style))continue;
      const bytes=fontData(cand.style.font),parsed=parseFont(bytes);
      if(!parsed.ok||glyphMissing(parsed,text).length)continue;
      const rights=fsTypeInfo(parsed);if(!rights.allowed)continue;
      return{ok:true,source:"same PDF",bytes,parsed,rights}
    }
  }
  return null
}
async function findInstalled(orig,text){
  if(!("queryLocalFonts" in window))return{ok:false,reason:"Local Font Access is not available in this Chrome build"};
  try{
    const target=styleIdentity(orig);let fonts=[];
    try{fonts=await window.queryLocalFonts({postscriptNames:[target.base]})}catch{}
    if(!fonts.length)fonts=await window.queryLocalFonts();
    for(const fd of fonts){
      const nm=(fd.postscriptName+" "+fd.family+" "+fd.style).toLowerCase();
      const bold=/bold|black|heavy|semibold|demibold/.test(nm),slanted=/italic|oblique/.test(nm);
      if(!((norm(fd.postscriptName)===norm(target.base)||norm(fd.family)===norm(target.family)||norm(fd.family)===norm(target.base))&&bold===target.bold&&slanted===target.slanted))continue;
      const bytes=new Uint8Array(await(await fd.blob()).arrayBuffer());
      const v=validateFontBytes(bytes,orig,text,"installed");if(v.ok){v.label=fd.fullName||fd.postscriptName;return v}
    }
    return{ok:false,reason:"Exact installed font was not found"}
  }catch(e){return{ok:false,reason:e.message}}
}
function overlapArea(a,b){
  const l=Math.max(a.left,b.left),r=Math.min(a.right,b.right),bo=Math.max(a.bottom,b.bottom),t=Math.min(a.top,b.top);
  return Math.max(0,r-l)*Math.max(0,t-bo)
}
function objArea(a){return Math.max(0,a.right-a.left)*Math.max(0,a.top-a.bottom)}
function newCollision(before,after,others){
  for(const o of others){
    const b=overlapArea(before,o.bounds),a=overlapArea(after,o.bounds);
    if(a>Math.max(1,Math.min(objArea(after),objArea(o.bounds))*.05)&&a>b+.75)return o
  }
  return null
}
function setText(o,text){
  const r=rt(),n=(text.length+1)*2,p=r.malloc(n);
  try{r.w16(text,p,n);if(!S.m.FPDFText_SetText(o,p))throw Error("FPDFText_SetText failed")}finally{r.free(p)}
}

function fontType(bytes){
  if(bytes.length<4)return FONT_TRUETYPE;const s=String.fromCharCode(...bytes.slice(0,4));
  return(s==="OTTO"||s==="typ1")?FONT_TYPE1:FONT_TRUETYPE
}
function copyGraphics(src,dst){
  const s=readStyle(src);if(s.transparency)throw Error("Strict edit blocked: text uses transparency");
  writeMatrix(dst,s.matrix);
  if(!S.m.FPDFPageObj_SetFillColor(dst,...s.fill))throw Error("Could not preserve fill color");
  if(!S.m.FPDFPageObj_SetStrokeColor(dst,...s.stroke))throw Error("Could not preserve stroke color");
  if(!S.m.FPDFPageObj_SetStrokeWidth(dst,s.strokeWidth))throw Error("Could not preserve stroke width");
  if(!S.m.FPDFTextObj_SetTextRenderMode(dst,s.render))throw Error("Could not preserve text render mode");
  return s
}
function rebuildWithFont(doc,page,obj,fontBytes,newText){
  const r=rt(),p=r.malloc(fontBytes.length);r.heap().set(fontBytes,p);
  let font=0,newObj=0,inserted=false;
  try{
    font=S.m.FPDFText_LoadFont(doc,p,fontBytes.length,fontType(fontBytes),1);if(!font)throw Error("PDFium could not load exact font");
    const old=readStyle(obj);newObj=S.m.FPDFPageObj_CreateTextObj(doc,font,old.size);if(!newObj)throw Error("Could not create replacement text");
    setText(newObj,newText);copyGraphics(obj,newObj);S.m.FPDFPage_InsertObject(page,newObj);inserted=true;
    if(!S.m.FPDFPage_RemoveObject(page,obj))throw Error("Could not remove original text");S.m.FPDFPageObj_Destroy(obj);
    return{obj:newObj,font}
  }catch(e){
    if(newObj&&!inserted)S.m.FPDFPageObj_Destroy(newObj);if(font)S.m.FPDFFont_Close(font);throw e
  }finally{r.free(p)}
}
function renderDocBitmap(doc,pageIndex,scale=1){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)throw Error("Cannot render verification page");
  try{
    const wpt=S.m.FPDF_GetPageWidthF(page),hpt=S.m.FPDF_GetPageHeightF(page);
    const w=Math.max(1,Math.floor(wpt*scale)),h=Math.max(1,Math.floor(hpt*scale)),r=rt(),buf=r.malloc(w*h*4);
    const bm=S.m.FPDFBitmap_CreateEx(w,h,4,buf,w*4);if(!bm){r.free(buf);throw Error("Could not create verification bitmap")}
    try{
      S.m.FPDFBitmap_FillRect(bm,0,0,w,h,0xffffffff);
      S.m.FPDF_RenderPageBitmap(bm,page,0,0,w,h,0,16);
      return{width:w,height:h,pageWidth:wpt,pageHeight:hpt,scale,rgba:r.heap().slice(buf,buf+w*h*4)}
    }finally{S.m.FPDFBitmap_Destroy(bm);r.free(buf)}
  }finally{S.m.FPDF_ClosePage(page)}
}
function unionRect(a,b){
  return{left:Math.min(a.left,b.left),bottom:Math.min(a.bottom,b.bottom),right:Math.max(a.right,b.right),top:Math.max(a.top,b.top)}
}
function collateralPixelDiff(before,after,region,pad=5){
  if(before.width!==after.width||before.height!==after.height)return Infinity;
  const scale=before.scale;
  const left=Math.max(0,Math.floor((region.left-pad)*scale));
  const right=Math.min(before.width-1,Math.ceil((region.right+pad)*scale));
  const top=Math.max(0,Math.floor((before.pageHeight-(region.top+pad))*scale));
  const bottom=Math.min(before.height-1,Math.ceil((before.pageHeight-(region.bottom-pad))*scale));
  let changed=0;
  for(let y=0;y<before.height;y++){
    for(let x=0;x<before.width;x++){
      if(x>=left&&x<=right&&y>=top&&y<=bottom)continue;
      const k=(y*before.width+x)*4;
      if(
        Math.abs(before.rgba[k]-after.rgba[k])>12||
        Math.abs(before.rgba[k+1]-after.rgba[k+1])>12||
        Math.abs(before.rgba[k+2]-after.rgba[k+2])>12||
        Math.abs(before.rgba[k+3]-after.rgba[k+3])>12
      ){
        changed++;
        if(changed>24)return changed
      }
    }
  }
  return changed
}

function saveDoc(doc){
  const r=rt(),w=S.m.PDFiumExt_OpenFileWriter();if(!w)throw Error("Could not create PDF writer");
  try{
    if(!S.m.PDFiumExt_SaveAsCopy(doc,w))throw Error("PDF save failed");
    const n=S.m.PDFiumExt_GetFileWriterSize(w);if(!n)throw Error("Saved PDF is empty");
    const p=r.malloc(n);try{S.m.PDFiumExt_GetFileWriterData(w,p,n);return r.heap().slice(p,p+n)}finally{r.free(p)}
  }finally{S.m.PDFiumExt_CloseFileWriter(w)}
}
function tempOpen(bytes){
  const r=rt(),p=r.malloc(bytes.length);r.heap().set(bytes,p);
  const d=S.m.FPDF_LoadMemDocument(p,bytes.length,0);if(!d){r.free(p);throw Error("Working-copy open failed")}
  return{doc:d,close(){S.m.FPDF_CloseDocument(d);r.free(p)}}
}
function findTextRange(doc,pageIndex,text,near){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)return null;
  const tp=S.m.FPDFText_LoadPage(page),r=rt(),n=(text.length+1)*2,p=r.malloc(n);
  try{
    const handleToIndex=new Map(),objectCount=S.m.FPDFPage_CountObjects(page);
    for(let i=0;i<objectCount;i++)handleToIndex.set(S.m.FPDFPage_GetObject(page,i),i);

    r.w16(text,p,n);
    const handle=S.m.FPDFText_FindStart(tp,p,1,0); // FPDF_MATCHCASE
    if(!handle)return null;

    let best=null,bestScore=-Infinity;
    try{
      while(S.m.FPDFText_FindNext(handle)){
        const start=S.m.FPDFText_GetSchResultIndex(handle),count=S.m.FPDFText_GetSchCount(handle);
        const boxes=[];let firstObjIndex=null;
        for(let i=start;i<start+count;i++){
          const b=readCharBox(tp,i);if(b)boxes.push(b);
          if(firstObjIndex==null){
            const o=S.m.FPDFText_GetTextObject(tp,i);
            if(o)firstObjIndex=handleToIndex.get(o)??null
          }
        }
        if(!boxes.length)continue;
        const bounds={
          left:Math.min(...boxes.map(b=>b.left)),
          bottom:Math.min(...boxes.map(b=>b.bottom)),
          right:Math.max(...boxes.map(b=>b.right)),
          top:Math.max(...boxes.map(b=>b.top))
        };
        const overlap=overlapArea(near,bounds);
        const dx=Math.abs(((near.left+near.right)-(bounds.left+bounds.right))/2);
        const dy=Math.abs(((near.top+near.bottom)-(bounds.top+bounds.bottom))/2);
        const score=overlap*1000-dx-dy;
        if(score>bestScore){
          best={start,count,bounds,objIndex:firstObjIndex};
          bestScore=score
        }
      }
    }finally{S.m.FPDFText_FindClose(handle)}
    return best
  }finally{r.free(p);S.m.FPDFText_ClosePage(tp);S.m.FPDF_ClosePage(page)}
}

function unicodeAuditRange(doc,pageIndex,start,count){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)return{text:"",mapErrors:1,zeroUnicode:1};
  const tp=S.m.FPDFText_LoadPage(page);let text="",mapErrors=0,zeroUnicode=0;
  try{
    for(let i=start;i<start+count;i++){
      const cp=S.m.FPDFText_GetUnicode(tp,i);
      const err=typeof S.m.FPDFText_HasUnicodeMapError==="function"?S.m.FPDFText_HasUnicodeMapError(tp,i):0;
      if(err!==0)mapErrors++;if(!cp)zeroUnicode++;else text+=String.fromCodePoint(cp)
    }
    return{text,mapErrors,zeroUnicode}
  }finally{S.m.FPDFText_ClosePage(tp);S.m.FPDF_ClosePage(page)}
}

function readObjectSnapshot(doc,pageIndex,objIndex){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)return null;
  const tp=S.m.FPDFText_LoadPage(page);
  try{
    const obj=S.m.FPDFPage_GetObject(page,objIndex);
    if(!obj||S.m.FPDFPageObj_GetType(obj)!==TEXT)return null;
    return{text:readText(obj,tp),style:readStyle(obj),bounds:readBounds(obj)}
  }finally{S.m.FPDFText_ClosePage(tp);S.m.FPDF_ClosePage(page)}
}

function compareStyles(a,b,resolved){
  const c=[],push=(n,v)=>c.push([n,!!v]);
  push("Font identity preserved",sameIdentity(a,b));push("Font size preserved",Math.abs(a.size-b.size)<.03);
  push("Font weight preserved",a.weight<0||b.weight<0||a.weight===b.weight);push("Italic preserved",a.italic===b.italic);
  push("Fill preserved",JSON.stringify(a.fill)===JSON.stringify(b.fill));push("Stroke preserved",JSON.stringify(a.stroke)===JSON.stringify(b.stroke));
  push("Stroke width preserved",Math.abs(a.strokeWidth-b.strokeWidth)<.01);push("Render mode preserved",a.render===b.render);
  push("Position/transform preserved",a.matrix.every((v,i)=>Math.abs(v-b.matrix[i])<.0005));
  if(resolved)push("Resolved font embedded",b.embedded===1);return c
}
async function editTransaction(selected,newText,resolverOverride=null){
  if(!selected?.editable){
    throw new KernelError("KERNEL_UNSUPPORTED_SELECTION",selected?.reason||"This word is not safely editable.");
  }

  const pf=embeddedPreflight(selected,newText);
  let resolver=resolverOverride,mode="Text Kernel range edit";
  if(selected.style.embedded!==1||!pf.parsed.ok||pf.missing.length){
    resolver=resolver||findInPdf(selected.style,newText)||await findInVault(selected.style,newText);
    if(!resolver?.ok){
      const err=new Error(`Exact font required for: ${pf.missing.map(cpLabel).join(", ")||stripSubset(selected.style.fontName)}`);
      err.code="EXACT_FONT_REQUIRED";err.preflight=pf;throw err
    }
    mode=`Text Kernel exact-font range rebuild (${resolver.source})`
  }

  const wk=tempOpen(S.bytes);
  try{
    const beforeBitmap=renderDocBitmap(wk.doc,selected.page,1);
    const page=S.m.FPDF_LoadPage(wk.doc,selected.page);if(!page)throw Error("Could not load page");
    let edited=null,loadedFont=0,origStyle=null,origObjectBounds=null,expectedPrimaryText="";
    try{
      const freshKernel=buildPageKernel(wk.doc,selected.page);
      const records=freshKernel.objects;
      const plan=planWordReplacement(selected,newText,records);
      const primaryAction=plan.primary;
      const primaryRec=records.get(primaryAction.objIndex);
      if(!primaryRec)throw new KernelError("KERNEL_PRIMARY_MISSING","Primary PDF text object is unavailable.");

      origStyle=primaryRec.style;
      origObjectBounds=primaryRec.bounds;
      expectedPrimaryText=primaryAction.newText;

      if(!selected.style||!sameVisualStyle(origStyle,selected.style)){
        throw new KernelError("KERNEL_STYLE_CHANGED","The PDF text style changed between selection and commit. Click the word again.");
      }

      const handles=new Map();
      for(const action of plan.actions){
        const h=S.m.FPDFPage_GetObject(page,action.objIndex);
        if(!h||S.m.FPDFPageObj_GetType(h)!==TEXT){
          throw new KernelError("KERNEL_OBJECT_CHANGED","An underlying PDF text object changed. Click the word again.");
        }
        handles.set(action.objIndex,h)
      }

      const selectedSet=new Set(plan.actions.map(a=>a.objIndex));
      const others=listObjects(wk.doc,selected.page).filter(o=>!selectedSet.has(o.index));

      const primaryObj=handles.get(primaryAction.objIndex);
      if(resolver){
        const rebuilt=rebuildWithFont(wk.doc,page,primaryObj,resolver.bytes,primaryAction.newText);
        edited=rebuilt.obj;loadedFont=rebuilt.font;
      }else{
        setText(primaryObj,primaryAction.newText);
        edited=primaryObj
      }

      // Secondary objects are only removed when the kernel proved that the
      // entire object consists of selected fragments. Otherwise planning blocks.
      for(const action of plan.actions.slice(1)){
        if(!action.removeObject){
          throw new KernelError("KERNEL_SECONDARY_REWRITE_UNSUPPORTED","A secondary PDF object would need a partial rewrite; blocked.");
        }
        const extra=handles.get(action.objIndex);
        if(!S.m.FPDFPage_RemoveObject(page,extra))throw Error("Could not remove a selected PDF text fragment");
        S.m.FPDFPageObj_Destroy(extra)
      }

      try{
        if(!S.m.FPDFPage_GenerateContent(page))throw Error("Could not regenerate PDF page content")
      }finally{
        if(loadedFont)S.m.FPDFFont_Close(loadedFont)
      }

      const afterObjectBounds=readBounds(edited);
      if(!afterObjectBounds)throw Error("Edited text-object bounds are unavailable");

      const collision=newCollision(origObjectBounds,afterObjectBounds,others);
      if(collision){
        throw new KernelError("KERNEL_COLLISION",`Replacement would overlap "${collision.text}"`);
      }
    }finally{S.m.FPDF_ClosePage(page)}

    const out=saveDoc(wk.doc),vr=tempOpen(out);
    try{
      const match=findTextRange(vr.doc,selected.page,newText,selected.bounds);
      if(!match)throw Error("Saved PDF reopened, but the replacement text could not be located.");
      if(match.objIndex==null)throw Error("Saved replacement is not associated with a PDF text object.");

      const audit=unicodeAuditRange(vr.doc,selected.page,match.start,match.count);
      const saved=readObjectSnapshot(vr.doc,selected.page,match.objIndex);
      if(!saved)throw Error("Saved primary PDF text object could not be reopened.");

      const checks=compareStyles(origStyle,saved.style,!!resolver);
      checks.push(["Replacement text found after save/reopen",true]);
      checks.push(["Unselected prefix/suffix preserved",saved.text===expectedPrimaryText]);
      checks.push(["Unicode mapping valid",audit.mapErrors===0&&audit.zeroUnicode===0]);
      checks.push(["Unicode text matches",audit.text===newText]);
      if(!resolver){
        checks.push(["Exact embedded font program preserved",fontFingerprint(origStyle.font)===fontFingerprint(saved.style.font)]);
      }

      // Render both PDFs with the same PDFium engine. Changes outside the union
      // of old/new word boxes are collateral damage and fail the transaction.
      const afterBitmap=renderDocBitmap(vr.doc,selected.page,1);
      const visualRegion=unionRect(selected.bounds,match.bounds);
      const collateral=collateralPixelDiff(beforeBitmap,afterBitmap,visualRegion,3);
      checks.push(["No collateral visual changes outside edited word",collateral<=24]);

      if(!checks.every(x=>x[1])){
        throw Error(`Verification failed: ${checks.filter(x=>!x[1]).map(x=>x[0]).join(", ")}`);
      }
      return{out,mode,checks}
    }finally{vr.close()}
  }finally{wk.close()}
}

function pageDimensions(index){
  const page=S.m.FPDF_LoadPage(S.doc,index);if(!page)return{width:612,height:792,rotation:0};
  try{return{width:S.m.FPDF_GetPageWidthF(page),height:S.m.FPDF_GetPageHeightF(page),rotation:S.m.FPDFPage_GetRotation(page)}}finally{S.m.FPDF_ClosePage(page)}
}
function renderBitmap(pageIndex,scale){
  const page=S.m.FPDF_LoadPage(S.doc,pageIndex);if(!page)throw Error("Cannot render page");
  try{
    const wpt=S.m.FPDF_GetPageWidthF(page),hpt=S.m.FPDF_GetPageHeightF(page),dpr=Math.min(devicePixelRatio||1,1.75);
    const w=Math.max(1,Math.floor(wpt*scale*dpr)),h=Math.max(1,Math.floor(hpt*scale*dpr)),r=rt(),buf=r.malloc(w*h*4);
    const bm=S.m.FPDFBitmap_CreateEx(w,h,4,buf,w*4);if(!bm){r.free(buf);throw Error("Could not create PDF bitmap")}
    try{
      S.m.FPDFBitmap_FillRect(bm,0,0,w,h,0xffffffff);S.m.FPDF_RenderPageBitmap(bm,page,0,0,w,h,0,16);
      return{width:w,height:h,cssWidth:wpt*scale,cssHeight:hpt*scale,rgba:new Uint8ClampedArray(r.heap().slice(buf,buf+w*h*4).buffer)}
    }finally{S.m.FPDFBitmap_Destroy(bm);r.free(buf)}
  }finally{S.m.FPDF_ClosePage(page)}
}
function calcFitScale(){
  const workspaceWidth=Math.max(620,$("workspace").clientWidth-80);
  let maxWidth=612;for(const m of S.pageMetrics)maxWidth=Math.max(maxWidth,m.width);
  return Math.min(1.35,workspaceWidth/maxWidth)
}
async function renderAll(){
  cancelInline();
  S.pageMetrics=Array.from({length:S.pages},(_,i)=>pageDimensions(i));S.fitScale=calcFitScale();
  const scale=S.fitScale*S.zoom,pages=$("pages"),sidebar=$("sidebar");pages.innerHTML="";sidebar.innerHTML="";
  $("pageTotal").textContent=String(S.pages);$("zoomLabel").textContent=`${Math.round(S.zoom*100)}%`;

  for(let i=0;i<S.pages;i++){
    const metric=S.pageMetrics[i];
    const shell=document.createElement("div");shell.className="page-shell";shell.dataset.page=String(i);
    shell.style.width=`${metric.width*scale}px`;shell.style.height=`${metric.height*scale}px`;
    const canvas=document.createElement("canvas"),layer=document.createElement("div");layer.className="text-layer";
    shell.append(canvas,layer);pages.appendChild(shell);

    const bmp=renderBitmap(i,scale);canvas.width=bmp.width;canvas.height=bmp.height;canvas.style.width=`${bmp.cssWidth}px`;canvas.style.height=`${bmp.cssHeight}px`;
    canvas.getContext("2d").putImageData(new ImageData(bmp.rgba,bmp.width,bmp.height),0,0);

    if(metric.rotation===0){
      const kernel=buildPageKernel(S.doc,i);S.kernels.set(i,kernel);const objects=kernel.words;
      for(const obj of objects){
        const b=obj.bounds,hit=document.createElement("button");hit.className=`text-hit ${obj.editable?"":"kernel-blocked"}`;hit.title=S.editMode?(obj.editable?`Edit full word: ${obj.text}`:`Blocked: ${obj.reason}`):"";
        hit.style.left=`${b.left*scale}px`;hit.style.top=`${(metric.height-b.top)*scale}px`;
        hit.style.width=`${Math.max(5,(b.right-b.left)*scale)}px`;hit.style.height=`${Math.max(7,(b.top-b.bottom)*scale)}px`;
        hit.onclick=e=>{e.stopPropagation();if(!S.editMode)return;if(!obj.editable){toast(obj.reason||"This word is not safely editable","err");return}startInline(obj,hit,shell,scale)};
        layer.appendChild(hit)
      }
    }

    const thumb=document.createElement("button");thumb.className=`thumb ${i===S.currentPage?"active":""}`;thumb.dataset.page=String(i);
    const tc=document.createElement("canvas"),label=document.createElement("span");label.textContent=String(i+1);thumb.append(tc,label);sidebar.appendChild(thumb);
    const thumbScale=Math.min(.18,112/metric.width),tb=renderBitmap(i,thumbScale);
    tc.width=tb.width;tc.height=tb.height;tc.style.width=`${tb.cssWidth}px`;tc.style.height=`${tb.cssHeight}px`;
    tc.getContext("2d").putImageData(new ImageData(tb.rgba,tb.width,tb.height),0,0);
    thumb.onclick=()=>shell.scrollIntoView({block:"start",behavior:"smooth"})
  }
  observePages()
}
let observer=null;
function observePages(){
  observer?.disconnect();
  observer=new IntersectionObserver(entries=>{
    const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
    if(!visible)return;S.currentPage=Number(visible.target.dataset.page);$("pageInput").value=String(S.currentPage+1);
    document.querySelectorAll(".thumb").forEach(x=>x.classList.toggle("active",Number(x.dataset.page)===S.currentPage))
  },{root:$("workspace"),threshold:[.15,.35,.6]});
  document.querySelectorAll(".page-shell").forEach(x=>observer.observe(x))
}
function setEditMode(on){
  S.editMode=!!on;document.body.classList.toggle("editing",S.editMode);$("editBtn").classList.toggle("active",S.editMode);
  if(!S.editMode)cancelInline();toast(S.editMode?"Inline edit mode on":"View mode")
}
function removeInlineDom(inline=S.inline){
  if(!inline)return;
  try{inline.input?.remove()}catch{}
  try{inline.hint?.remove()}catch{}
  try{inline.actions?.remove()}catch{}
}
function cancelInline(){
  if(S.commitBusy)return;
  removeInlineDom();
  S.inline=null;
}
function setInlineBusy(busy,message="Verifying…"){
  if(!S.inline)return;
  S.commitBusy=busy;
  S.inline.input.disabled=busy;
  S.inline.input.classList.toggle("busy",busy);
  if(S.inline.hint)S.inline.hint.textContent=busy?message:"Enter or ✓ = save • Esc or × = cancel";
  if(S.inline.saveButton)S.inline.saveButton.disabled=busy;
  if(S.inline.cancelButton)S.inline.cancelButton.disabled=busy;
}
function startInline(obj,hit,shell,scale){
  if(S.commitBusy)return;
  cancelInline();S.resolvedFont=null;
  const b=obj.bounds,input=document.createElement("input"),hint=document.createElement("div");
  const actions=document.createElement("div"),saveButton=document.createElement("button"),cancelButton=document.createElement("button");

  input.className="inline-editor";input.value=obj.text;input.spellcheck=false;
  input.style.left=`${b.left*scale}px`;input.style.top=`${(S.pageMetrics[obj.page].height-b.top)*scale}px`;
  input.style.width=`${Math.max(120,(b.right-b.left)*scale+36)}px`;
  input.style.height=`${Math.max(24,(b.top-b.bottom)*scale+8)}px`;
  input.style.fontSize=`${Math.max(11,obj.style.size*scale)}px`;

  hint.className="inline-hint";hint.textContent="Enter or ✓ = save • Esc or × = cancel";
  hint.style.left=input.style.left;hint.style.top=`${(S.pageMetrics[obj.page].height-b.bottom)*scale+7}px`;

  actions.className="inline-actions";
  actions.style.left=`${b.left*scale+Math.max(120,(b.right-b.left)*scale+36)+6}px`;
  actions.style.top=input.style.top;

  saveButton.className="inline-action save";saveButton.type="button";saveButton.textContent="✓";saveButton.title="Save verified edit";
  cancelButton.className="inline-action cancel";cancelButton.type="button";cancelButton.textContent="×";cancelButton.title="Cancel edit";
  actions.append(saveButton,cancelButton);

  shell.append(input,hint,actions);
  S.inline={obj,input,hint,actions,saveButton,cancelButton,shell,scale};

  saveButton.onclick=async e=>{e.preventDefault();e.stopPropagation();await queueInlineCommit()};
  cancelButton.onclick=e=>{e.preventDefault();e.stopPropagation();cancelInline()};

  let composing=false;
  input.addEventListener("compositionstart",()=>{composing=true});
  input.addEventListener("compositionend",()=>{composing=false});
  input.addEventListener("keydown",async e=>{
    if(e.key==="Escape"&&!S.commitBusy){e.preventDefault();e.stopPropagation();cancelInline();return}
    if(e.key==="Enter"){
      e.preventDefault();e.stopPropagation();
      if(e.repeat||composing||e.isComposing||e.keyCode===229)return;
      await queueInlineCommit();
    }
  });

  input.focus();
  input.select();
}
async function queueInlineCommit(resolverOverride=null){
  if(!S.inline||S.commitBusy)return;
  // Yield one microtask so the input's latest value is guaranteed to be visible.
  await Promise.resolve();
  if(!S.inline||S.commitBusy)return;
  await commitInline(resolverOverride);
}
async function commitInline(resolverOverride=null){
  if(!S.inline||S.commitBusy)return;
  const selected=S.inline.obj;
  const newText=String(S.inline.input.value ?? "");
  if(!newText.length){toast("Empty replacement is not allowed","err");return}
  if(newText===selected.text){cancelInline();return}

  setInlineBusy(true,"Verifying PDF edit…");
  try{
    const before=S.bytes.slice();
    const result=await editTransaction(selected,newText,resolverOverride);
    S.history.push(before);if(S.history.length>30)S.history.shift();
    openBytes(result.out);S.dirty=true;$("undoBtn").disabled=false;$("saveBtn").classList.add("dirty");

    // Clear the edit UI only AFTER the verified output has become the working PDF.
    const oldInline=S.inline;
    S.inline=null;S.commitBusy=false;removeInlineDom(oldInline);
    await renderAll();
    toast(selected.slices?.length>1?`Saved ✓ — full word verified across ${selected.slices.length} PDF runs`:"Saved ✓ — verified full-word edit","ok");
  }catch(e){
    S.commitBusy=false;
    if(e.code==="EXACT_FONT_REQUIRED"){
      // IMPORTANT: preserve the user's exact typed value and object.
      S.pendingFont={selected,newText};
      if(S.inline){
        S.inline.input.disabled=false;S.inline.input.classList.remove("busy");
        S.inline.hint.textContent="Exact font required — your correction is preserved";
        S.inline.saveButton.disabled=false;S.inline.cancelButton.disabled=false;
      }
      openFontModal(e.message);
    }else{
      if(S.inline){
        S.inline.input.disabled=false;
        S.inline.input.classList.remove("busy");
        S.inline.hint.textContent="Enter or ✓ = retry • Esc or × = cancel";
        S.inline.saveButton.disabled=false;
        S.inline.cancelButton.disabled=false;
        S.inline.input.focus();
      }
      toast(e.message,"err");
    }
  }
}
function openFontModal(reason){
  $("fontReason").textContent=reason+". AttachmentGuard will not substitute another font.";
  $("fontStatus").textContent="Your typed correction is preserved. Resolve the exact font and AttachmentGuard will apply it automatically.";
  $("fontModal").classList.add("open")
}
function closeFontModal(){
  S.pendingFont=null;S.resolvedFont=null;$("fontModal").classList.remove("open");$("fontUpload").value="";
  // Canceling the font prompt does NOT discard the user's typed edit.
  if(S.inline){
    S.inline.input.disabled=false;S.inline.input.classList.remove("busy");
    S.inline.hint.textContent="Exact font unresolved — edit is still here • Enter or ✓ to retry";
    S.inline.saveButton.disabled=false;S.inline.cancelButton.disabled=false;S.inline.input.focus();
  }
}
async function useResolvedFont(v){
  if(!v?.ok){$("fontStatus").textContent=v?.reason||"Exact font not found.";return}
  S.resolvedFont=v;await rememberFont(v);
  $("fontStatus").textContent=`Exact font resolved ✅ ${v.label||v.source}. Applying your preserved edit…`;
  const pending=S.pendingFont;if(!pending)return;
  S.pendingFont=null;$("fontModal").classList.remove("open");

  // Keep the real inline input intact until the transaction passes.
  if(!S.inline){
    toast("The inline edit is no longer active. Click the text once more.","err");
    return;
  }

  setInlineBusy(true,"Applying exact font and verifying…");
  try{
    const before=S.bytes.slice();
    const result=await editTransaction(pending.selected,pending.newText,v);
    S.history.push(before);if(S.history.length>30)S.history.shift();
    openBytes(result.out);S.dirty=true;$("undoBtn").disabled=false;$("saveBtn").classList.add("dirty");

    const oldInline=S.inline;
    S.inline=null;S.commitBusy=false;removeInlineDom(oldInline);
    await renderAll();
    toast("Saved ✓ — exact font verified","ok")
  }catch(e){
    S.commitBusy=false;
    if(S.inline){
      S.inline.input.disabled=false;S.inline.input.classList.remove("busy");
      S.inline.hint.textContent="Font resolved, but verification failed • Enter or ✓ to retry";
      S.inline.saveButton.disabled=false;S.inline.cancelButton.disabled=false;S.inline.input.focus();
    }
    toast(e.message,"err")
  }
}
$("findInstalledFont").onclick=async()=>{
  if(!S.pendingFont)return;
  $("fontStatus").textContent="Chrome may ask permission to access installed fonts…";
  const v=await findInstalled(S.pendingFont.selected.style,S.pendingFont.newText);
  await useResolvedFont(v)
};
$("fontUpload").onchange=async e=>{
  if(!S.pendingFont)return;const f=e.target.files?.[0];if(!f)return;
  const bytes=new Uint8Array(await f.arrayBuffer()),v=validateFontBytes(bytes,S.pendingFont.selected.style,S.pendingFont.newText,"uploaded");
  if(v.ok)v.label=f.name;
  await useResolvedFont(v)
};
$("fontCancel").onclick=closeFontModal;

async function captureStream(){
  if(!chrome.mimeHandler?.getStreamInfo)throw Error("Chrome PDF stream API is unavailable");
  const info=await chrome.mimeHandler.getStreamInfo();const response=await fetch(info.streamUrl,{cache:"no-store"});
  if(!response.ok)throw Error(`PDF stream returned HTTP ${response.status}`);
  return{info,bytes:new Uint8Array(await response.arrayBuffer())}
}
const streamPromise=captureStream();

function streamHeader(headers,name){
  if(!headers||typeof headers!=="object")return"";for(const[k,v]of Object.entries(headers))if(String(k).toLowerCase()===name.toLowerCase())return String(v??"");return""
}
function fileNameFromUrl(url){
  try{const u=new URL(url),raw=decodeURIComponent(u.pathname.split("/").filter(Boolean).pop()||"document.pdf");return raw.toLowerCase().endsWith(".pdf")?raw:`${raw}.pdf`}catch{return"document.pdf"}
}
function fileNameFromDisposition(header,fallback){
  if(!header)return fallback;const utf=header.match(/filename\*=UTF-8''([^;]+)/i);if(utf){try{return decodeURIComponent(utf[1].replace(/^["']|["']$/g,""))}catch{}}
  const plain=header.match(/filename="?([^";]+)"?/i);return plain?plain[1]:fallback
}
function normalizeDownloadName(raw){
  let name=String(raw||"").trim();
  name=name.replace(/[<>:"/\\|?*\u0000-\u001F]/g,"-").replace(/[. ]+$/g,"");
  if(!name)name="document.pdf";
  const stem=name.replace(/\.pdf$/i,"");
  const reserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  name=(reserved.test(stem)?`_${stem}`:stem)+".pdf";
  if(name.length>180){
    const base=name.slice(0,176).replace(/[. ]+$/g,"");
    name=`${base}.pdf`;
  }
  return name;
}
function applyFilenameFromToolbar({notify=false}={}){
  const normalized=normalizeDownloadName($("filename").value);
  $("filename").value=normalized;S.name=normalized;document.title=normalized;
  if(notify)toast(`Filename set to ${normalized}`,"ok");
  return normalized;
}

async function downloadPdf(){
  if(!S.bytes)return;
  const filename=applyFilenameFromToolbar();
  const blob=new Blob([S.bytes],{type:"application/pdf"}),url=URL.createObjectURL(blob);
  try{
    await chrome.downloads.download({
      url,
      filename,
      saveAs:true,
      conflictAction:"uniquify"
    })
  }finally{
    setTimeout(()=>URL.revokeObjectURL(url),5000)
  }
}

async function boot(){
  try{
    loading("Loading packaged PDFium engine…");
    const wasmRes=await fetch(WASM_URL,{cache:"force-cache"});if(!wasmRes.ok)throw Error(`PDFium WASM HTTP ${wasmRes.status}`);
    const wasmBinary=await wasmRes.arrayBuffer();S.m=await init({wasmBinary});S.m.PDFiumExt_Init();
    const test=S.m.FPDF_CreateNewDocument();if(!test)throw Error("PDFium self-test failed");S.m.FPDF_CloseDocument(test);

    loading("Receiving PDF directly from Chrome…");
    const {info,bytes}=await streamPromise;S.originalUrl=info.originalUrl||"";S.tabId=info.tabId??null;
    let name=fileNameFromUrl(S.originalUrl);name=fileNameFromDisposition(streamHeader(info.responseHeaders,"content-disposition"),name);
    S.name=name;S.filenameOriginal=name;S.originalBytes=bytes.slice();openBytes(bytes);$("filename").value=name;document.title=name;
    loading("Rendering PDF…");await renderAll();$("loading").classList.add("hidden");
  }catch(e){
    console.error(e);loading(`AttachmentGuard could not open this PDF: ${e.message}\nFalling back to Chrome viewer…`);
    setTimeout(()=>chrome.mimeHandler?.abortAndFallbackToNativeHandler?.(),700)
  }
}
boot();

$("filename").addEventListener("keydown",e=>{
  if(e.key==="Enter"){e.preventDefault();$("filename").blur();applyFilenameFromToolbar({notify:true})}
  if(e.key==="Escape"){e.preventDefault();$("filename").value=S.name;$("filename").blur()}
});
$("filename").addEventListener("blur",()=>applyFilenameFromToolbar());
$("filename").addEventListener("focus",()=>{$("filename").select()});

window.addEventListener("keydown",async e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){
    e.preventDefault();await downloadPdf();return;
  }
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"&&!e.shiftKey&&document.activeElement!==$("filename")){
    e.preventDefault();$("undoBtn").click();return;
  }
});

$("editBtn").onclick=()=>setEditMode(!S.editMode);
$("zoomIn").onclick=async()=>{S.zoom=Math.min(2.5,S.zoom+.1);await renderAll()};
$("zoomOut").onclick=async()=>{S.zoom=Math.max(.5,S.zoom-.1);await renderAll()};
$("pageInput").addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;const n=Math.max(1,Math.min(S.pages,Number($("pageInput").value)||1));
  document.querySelector(`.page-shell[data-page="${n-1}"]`)?.scrollIntoView({block:"start"})
});
$("undoBtn").onclick=async()=>{
  if(!S.history.length)return;const prev=S.history.pop();openBytes(prev);S.dirty=true;$("undoBtn").disabled=!S.history.length;await renderAll();toast("Undo ✓")
};
$("saveBtn").onclick=downloadPdf;
$("downloadBtn").onclick=downloadPdf;

chrome.runtime.onMessage.addListener(message=>{
  if(message?.type==="ATTACHMENTGUARD_TOGGLE_EDIT"&&(message.tabId==null||message.tabId===S.tabId))setEditMode(!S.editMode)
});

window.addEventListener("resize",()=>{
  clearTimeout(window.__agResize);window.__agResize=setTimeout(()=>renderAll().catch(console.error),180)
});

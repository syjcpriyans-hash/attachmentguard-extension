import { init } from "@embedpdf/pdfium";
import opentype from "opentype.js";
import { vaultCount, vaultList, vaultPut } from "./font-vault.js";

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
  pageMetrics:[], history:[], currentPage:0, inline:null, pendingFont:null, resolvedFont:null
};

function rt(){
  const p=S.m.pdfium;
  return {
    malloc:n=>{const x=p.wasmExports.malloc(n);if(!x&&n)throw Error("PDFium out of memory");return x},
    free:x=>x&&p.wasmExports.free(x),heap:()=>p.HEAPU8,gf:x=>p.getValue(x,"float"),
    gi:x=>p.getValue(x,"i32"),sf:(p2,v)=>p.setValue(p2,v,"float"),
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
function findByTextGeom(doc,pageIndex,text,near){
  const arr=listObjects(doc,pageIndex).filter(o=>o.text===text);
  arr.sort((a,b)=>overlapArea(near,b.bounds)-overlapArea(near,a.bounds));return arr[0]||null
}
function unicodeAudit(doc,pageIndex,objIndex){
  const page=S.m.FPDF_LoadPage(doc,pageIndex);if(!page)return{text:"",mapErrors:1,zeroUnicode:1};
  const target=S.m.FPDFPage_GetObject(page,objIndex),tp=S.m.FPDFText_LoadPage(page);
  let text="",mapErrors=0,zeroUnicode=0;
  try{
    const n=S.m.FPDFText_CountChars(tp);
    for(let i=0;i<n;i++){
      if(S.m.FPDFText_GetTextObject(tp,i)!==target)continue;
      const cp=S.m.FPDFText_GetUnicode(tp,i),err=typeof S.m.FPDFText_HasUnicodeMapError==="function"?S.m.FPDFText_HasUnicodeMapError(tp,i):0;
      if(err!==0)mapErrors++;if(!cp)zeroUnicode++;else text+=String.fromCodePoint(cp)
    }
    return{text,mapErrors,zeroUnicode}
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
  const pf=embeddedPreflight(selected,newText);let resolver=resolverOverride,mode="same PDF text object";
  if(selected.style.embedded!==1||!pf.parsed.ok||pf.missing.length){
    resolver=resolver||findInPdf(selected.style,newText)||await findInVault(selected.style,newText);
    if(!resolver?.ok){
      const err=new Error(`Exact font required for: ${pf.missing.map(cpLabel).join(", ")||stripSubset(selected.style.fontName)}`);
      err.code="EXACT_FONT_REQUIRED";err.preflight=pf;throw err
    }
    mode=`exact-font rebuild (${resolver.source})`
  }
  const wk=tempOpen(S.bytes);
  try{
    const page=S.m.FPDF_LoadPage(wk.doc,selected.page);if(!page)throw Error("Could not load page");
    let edited=null,loadedFont=0,origStyle,origBounds=selected.bounds;
    try{
      const obj=S.m.FPDFPage_GetObject(page,selected.index);if(!obj||S.m.FPDFPageObj_GetType(obj)!==TEXT)throw Error("Text object changed; click it again");
      origStyle=readStyle(obj);const others=listObjects(wk.doc,selected.page).filter(o=>o.index!==selected.index);
      if(!resolver){setText(obj,newText);edited=obj}else{const r=rebuildWithFont(wk.doc,page,obj,resolver.bytes,newText);edited=r.obj;loadedFont=r.font}
      try{if(!S.m.FPDFPage_GenerateContent(page))throw Error("Could not regenerate PDF page content")}
      finally{if(loadedFont)S.m.FPDFFont_Close(loadedFont)}
      const after=readBounds(edited),collision=newCollision(origBounds,after,others);
      if(collision)throw Error(`Edit blocked: new text would overlap "${collision.text}"`)
    }finally{S.m.FPDF_ClosePage(page)}
    const out=saveDoc(wk.doc),vr=tempOpen(out);
    try{
      const found=findByTextGeom(vr.doc,selected.page,newText,origBounds);if(!found)throw Error("Saved edit could not be found after reopening PDF");
      const audit=unicodeAudit(vr.doc,selected.page,found.index),checks=compareStyles(origStyle,found.style,!!resolver);
      checks.push(["Text saved exactly",found.text===newText]);
      checks.push(["Unicode mapping valid",audit.mapErrors===0&&audit.zeroUnicode===0]);
      checks.push(["Unicode text matches",audit.text.replace(/\s/g,"")===newText.replace(/\s/g,"")]);
      if(!resolver)checks.push(["Exact embedded font program preserved",fontFingerprint(origStyle.font)===fontFingerprint(found.style.font)]);
      if(!checks.every(x=>x[1]))throw Error(`Verification failed: ${checks.filter(x=>!x[1]).map(x=>x[0]).join(", ")}`);
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
      const objects=listObjects(S.doc,i);
      for(const obj of objects){
        const b=obj.bounds,hit=document.createElement("button");hit.className="text-hit";hit.title=S.editMode?`Edit: ${obj.text}`:"";
        hit.style.left=`${b.left*scale}px`;hit.style.top=`${(metric.height-b.top)*scale}px`;
        hit.style.width=`${Math.max(5,(b.right-b.left)*scale)}px`;hit.style.height=`${Math.max(7,(b.top-b.bottom)*scale)}px`;
        hit.onclick=e=>{e.stopPropagation();if(S.editMode)startInline(obj,hit,shell,scale)};
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
function cancelInline(){
  if(S.inline){S.inline.input.remove();S.inline.hint.remove();S.inline=null}
}
function startInline(obj,hit,shell,scale){
  cancelInline();S.resolvedFont=null;
  const b=obj.bounds,input=document.createElement("input"),hint=document.createElement("div");
  input.className="inline-editor";input.value=obj.text;input.spellcheck=false;
  input.style.left=`${b.left*scale}px`;input.style.top=`${(S.pageMetrics[obj.page].height-b.top)*scale}px`;
  input.style.width=`${Math.max(120,(b.right-b.left)*scale+36)}px`;
  input.style.height=`${Math.max(24,(b.top-b.bottom)*scale+8)}px`;
  input.style.fontSize=`${Math.max(11,obj.style.size*scale)}px`;
  hint.className="inline-hint";hint.textContent="Enter = save • Esc = cancel";
  hint.style.left=input.style.left;hint.style.top=`${(S.pageMetrics[obj.page].height-b.bottom)*scale+7}px`;
  shell.append(input,hint);S.inline={obj,input,hint,shell,scale};input.focus();input.select();
  input.addEventListener("keydown",async e=>{
    if(e.key==="Escape"){e.preventDefault();cancelInline()}
    if(e.key==="Enter"){e.preventDefault();await commitInline()}
  })
}
async function commitInline(resolverOverride=null){
  if(!S.inline)return;
  const selected=S.inline.obj,newText=S.inline.input.value;
  if(!newText.length){toast("Empty replacement is not allowed","err");return}
  if(newText===selected.text){cancelInline();return}
  S.inline.input.disabled=true;S.inline.hint.textContent="Verifying…";
  try{
    const result=await editTransaction(selected,newText,resolverOverride);
    S.history.push(S.bytes.slice());if(S.history.length>30)S.history.shift();
    openBytes(result.out);S.dirty=true;$("undoBtn").disabled=false;$("saveBtn").classList.add("dirty");
    cancelInline();await renderAll();toast("Saved ✓ — verified PDF edit","ok")
  }catch(e){
    if(e.code==="EXACT_FONT_REQUIRED"){
      S.pendingFont={selected,newText};cancelInline();openFontModal(e.message)
    }else{
      S.inline && (S.inline.input.disabled=false,S.inline.hint.textContent="Enter = retry • Esc = cancel");
      toast(e.message,"err")
    }
  }
}
function openFontModal(reason){
  $("fontReason").textContent=reason+". AttachmentGuard will not substitute another font.";
  $("fontStatus").textContent="";$("fontModal").classList.add("open")
}
function closeFontModal(){S.pendingFont=null;S.resolvedFont=null;$("fontModal").classList.remove("open");$("fontUpload").value=""}
async function useResolvedFont(v){
  if(!v?.ok){$("fontStatus").textContent=v?.reason||"Exact font not found.";return}
  S.resolvedFont=v;await rememberFont(v);$("fontStatus").textContent=`Exact font resolved ✅ ${v.label||v.source}. Applying edit…`;
  const pending=S.pendingFont;if(!pending)return;S.pendingFont=null;$("fontModal").classList.remove("open");
  // Recreate a temporary inline state only so commitInline can reuse the transaction path.
  S.inline={obj:pending.selected,input:{value:pending.newText,disabled:false},hint:{textContent:""},shell:null,scale:1};
  try{
    const result=await editTransaction(pending.selected,pending.newText,v);
    S.history.push(S.bytes.slice());if(S.history.length>30)S.history.shift();
    openBytes(result.out);S.dirty=true;$("undoBtn").disabled=false;$("saveBtn").classList.add("dirty");
    S.inline=null;await renderAll();toast("Saved ✓ — exact font verified","ok")
  }catch(e){S.inline=null;toast(e.message,"err")}
}
$("findInstalledFont").onclick=async()=>{
  if(!S.pendingFont)return;$("fontStatus").textContent="Chrome may ask permission to access installed fonts…";
  const v=await findInstalled(S.pendingFont.selected.style,S.pendingFont.newText);await useResolvedFont(v)
};
$("fontUpload").onchange=async e=>{
  if(!S.pendingFont)return;const f=e.target.files?.[0];if(!f)return;
  const bytes=new Uint8Array(await f.arrayBuffer()),v=validateFontBytes(bytes,S.pendingFont.selected.style,S.pendingFont.newText,"uploaded");
  if(v.ok)v.label=f.name;await useResolvedFont(v)
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
async function downloadPdf(){
  if(!S.bytes)return;const blob=new Blob([S.bytes],{type:"application/pdf"}),url=URL.createObjectURL(blob);
  try{await chrome.downloads.download({url,filename:S.name,saveAs:true})}finally{setTimeout(()=>URL.revokeObjectURL(url),5000)}
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
    S.name=name;S.originalBytes=bytes.slice();openBytes(bytes);$("filename").textContent=name;document.title=name;
    loading("Rendering PDF…");await renderAll();$("loading").classList.add("hidden");
  }catch(e){
    console.error(e);loading(`AttachmentGuard could not open this PDF: ${e.message}\nFalling back to Chrome viewer…`);
    setTimeout(()=>chrome.mimeHandler?.abortAndFallbackToNativeHandler?.(),700)
  }
}
boot();

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

(() => {
  const BUTTON_ID="attachmentguard-mail-edit";
  const OVERLAY_ID="attachmentguard-mail-overlay";
  let objectUrl=null;
  let scanTimer=null;

  const isVisible=el=>{
    if(!el)return false;
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>20&&r.height>12&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=="none"&&s.visibility!=="hidden";
  };
  const pdfishText=()=>{
    const text=(document.body?.innerText||"").slice(0,250000);
    return /\.pdf\b/i.test(text);
  };
  const likelyPreviewOpen=()=>{
    if(document.getElementById(OVERLAY_ID))return false;
    const dialogs=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(isVisible);
    if(dialogs.some(d=>/\.pdf\b/i.test(d.innerText||"")))return true;
    const frames=[...document.querySelectorAll("iframe,embed,object")].filter(isVisible);
    if(frames.some(el=>/\.pdf(?:$|[?#])/i.test(el.src||el.data||"")||(el.src||"").startsWith("blob:")))return true;
    // Gmail/Outlook/Zoho previews often show a large overlay while the attachment filename remains visible.
    const large=[...document.querySelectorAll("div")].filter(el=>{
      if(!isVisible(el))return false;
      const r=el.getBoundingClientRect();
      return r.width>innerWidth*.55&&r.height>innerHeight*.55&&/\.pdf\b/i.test(el.innerText||"");
    });
    return large.length>0;
  };

  function ensureButton(){
    const shouldShow=pdfishText()&&likelyPreviewOpen();
    let btn=document.getElementById(BUTTON_ID);
    if(!shouldShow){btn?.remove();return}
    if(btn)return;
    btn=document.createElement("button");
    btn.id=BUTTON_ID;
    btn.textContent="✎ Edit PDF";
    Object.assign(btn.style,{
      position:"fixed",top:"14px",right:"72px",zIndex:"2147483646",
      border:"0",borderRadius:"18px",padding:"8px 13px",
      background:"#1a73e8",color:"#fff",font:"600 12px Arial,sans-serif",
      cursor:"pointer",boxShadow:"0 2px 10px rgba(0,0,0,.28)"
    });
    btn.title="Edit this previewed PDF with AttachmentGuard";
    btn.onclick=()=>captureAndOpen(btn);
    document.documentElement.appendChild(btn)
  }

  function candidateUrls(){
    const urls=[],seen=new Set();
    const add=(url,score=0)=>{
      if(!url||typeof url!=="string")return;
      try{
        const abs=new URL(url,location.href).href;
        if(!/^https?:/i.test(abs))return;
        if(seen.has(abs))return;seen.add(abs);urls.push({url:abs,score})
      }catch{}
    };

    document.querySelectorAll("a[href]").forEach(a=>{
      if(!isVisible(a))return;
      const href=a.href||"",text=`${a.textContent||""} ${a.getAttribute("aria-label")||""} ${a.getAttribute("title")||""}`;
      let score=0;
      if(/\.pdf(?:$|[?#])/i.test(href))score+=100;
      if(/view=att|attid=|disp=att|attachment|download/i.test(href))score+=70;
      if(/download|open|attachment|pdf/i.test(text))score+=30;
      if(score)add(href,score)
    });
    document.querySelectorAll("iframe[src],embed[src],object[data]").forEach(el=>{
      if(!isVisible(el))return;
      const u=el.src||el.data||"";
      let score=/\.pdf(?:$|[?#])/i.test(u)?110:0;
      if(/view=att|attachment|download/i.test(u))score+=60;
      if(score)add(u,score)
    });
    return urls.sort((a,b)=>b.score-a.score).map(x=>x.url)
  }

  function pdfHeader(bytes){
    const n=Math.min(bytes.length,1024);
    let s="";for(let i=0;i<n;i++)s+=String.fromCharCode(bytes[i]);
    return s.includes("%PDF-")
  }

  async function fetchPdf(url){
    const res=await fetch(url,{credentials:"include",cache:"no-store",redirect:"follow"});
    if(!res.ok)throw Error(`HTTP ${res.status}`);
    const bytes=new Uint8Array(await res.arrayBuffer());
    if(!pdfHeader(bytes))throw Error(`not PDF (${res.headers.get("content-type")||"unknown type"})`);
    return{bytes,sourceUrl:res.url||url}
  }

  function closeOverlay(){
    document.getElementById(OVERLAY_ID)?.remove();
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null}
    document.body.style.overflow="";
    ensureButton()
  }

  function showOverlay(bytes){
    document.getElementById(BUTTON_ID)?.remove();
    objectUrl=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
    const overlay=document.createElement("div");
    overlay.id=OVERLAY_ID;
    Object.assign(overlay.style,{
      position:"fixed",inset:"0",zIndex:"2147483647",background:"#202124"
    });
    const frame=document.createElement("iframe");
    frame.src=objectUrl;
    frame.title="AttachmentGuard PDF editor";
    Object.assign(frame.style,{width:"100%",height:"100%",border:"0",display:"block"});
    const close=document.createElement("button");
    close.textContent="×";
    close.title="Return to mail preview";
    Object.assign(close.style,{
      position:"absolute",top:"9px",right:"10px",zIndex:"2",
      width:"32px",height:"32px",border:"0",borderRadius:"16px",
      background:"rgba(32,33,36,.9)",color:"#fff",font:"22px Arial",cursor:"pointer"
    });
    close.onclick=closeOverlay;
    overlay.append(frame,close);
    document.body.style.overflow="hidden";
    document.documentElement.appendChild(overlay)
  }

  async function captureAndOpen(btn){
    const original=btn.textContent;
    btn.disabled=true;btn.textContent="Loading PDF…";
    const candidates=candidateUrls();
    let lastError="No attachment URL was found in this mail preview.";
    for(const url of candidates){
      try{
        const {bytes}=await fetchPdf(url);
        showOverlay(bytes);
        return
      }catch(e){lastError=`${url}\n${e.message}`}
    }
    btn.disabled=false;btn.textContent=original;
    alert(
      "AttachmentGuard could see the PDF preview, but this mail provider did not expose a fetchable PDF URL in the page.\n\n"+
      "This preview needs a provider-specific attachment adapter. The PDF engine itself is unchanged.\n\n"+
      lastError
    )
  }

  const observer=new MutationObserver(()=>{
    clearTimeout(scanTimer);scanTimer=setTimeout(ensureButton,250)
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["src","href","aria-label","style","class"]});
  setInterval(ensureButton,1200);
  ensureButton();
})();

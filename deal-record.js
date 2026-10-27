const {capacityLabel}=require('./deal-capacity');
'use strict';
// Single self-contained PDF renderer. Both SMTP and downloads call createDealRecord.
// No Chromium, external font, runtime dependency, or HTML screenshot required.
const fs=require('fs');
const path=require('path');
const PAGE_W=595,PAGE_H=842;
const GOLD='.86 .67 .40',IVORY='.99 .93 .82',WHITE='.96 .95 .93',MUTED='.78 .75 .70';
const clean=v=>v===undefined||v===null||String(v).trim()===''?'Not specified':String(v).replace(/[\r\n\t]+/g,' ').trim();
const ascii=v=>clean(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e\xa0-\xff]/g,'?');
const esc=v=>ascii(v).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const money=(currency,value)=>`${clean(currency||'USD')} ${Number(value||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date=v=>v&&!Number.isNaN(Date.parse(v))?new Date(v).toLocaleString('en-GB',{timeZone:'Europe/Berlin',dateStyle:'medium',timeStyle:'short'})+' (Europe/Berlin)':'Not specified';
function routeFrom(listing,offer,b){
 const sources=[b,b?.trip,b?.dealTerms,listing?.data,listing?.details,listing,offer?.data,offer].filter(x=>x&&typeof x==='object');
 const pick=keys=>{for(const s of sources)for(const k of keys)if(typeof s[k]==='string'&&s[k].trim())return s[k].trim();return 'Not specified'};
 return {from:pick(['pickupLocation','pickup','origin','fromLocation','from','startLocation','loadingLocation','pickupAddress','originCity','fromCity','startCity','location']),to:pick(['deliveryLocation','delivery','destination','toLocation','to','endLocation','dropoffLocation','deliveryAddress','destinationCity','toCity','endCity'])};
}
function createDealRecord(b,db){
 const listing=(db.listings||[]).find(x=>x.id===b.listingId)||{};
 const offer=(db.offers||[]).find(x=>x.id===b.offerId)||{};
 const buyer=(db.users||[]).find(x=>x.id===b.buyerUserId)||{};
 const provider=(db.users||[]).find(x=>x.id===b.providerUserId)||{};
 const defaultRoles={driver:['REQUESTER','DRIVER'],truck:['REQUESTER','TRUCK OWNER'],warehouse:['REQUESTER','WAREHOUSE PROVIDER'],equipment:['REQUESTER','EQUIPMENT PROVIDER'],transport:['CARGO OWNER','TRANSPORT PROVIDER']};
 const roles=defaultRoles[b.dealType]||['REQUESTER','PROVIDER'];
 const buyerRole=clean(b.buyerDealRole||b.partyRoles?.buyer||capacityLabel(b.dealType,'buyer',buyer));
 const providerRole=clean(b.providerDealRole||b.partyRoles?.provider||capacityLabel(b.dealType,'provider',provider));
 const route=routeFrom(listing,offer,b),terms=b.dealTerms||{};
 // Fees are read from the booking snapshot, never recalculated from current admin settings.
 // Legacy records retain their original charged-party behavior rather than inventing payments.
 const feeFor=role=>{
  const exact=role==='buyer'?b.customerFeeUSD:b.providerFeeUSD;
  if(exact!==undefined&&exact!==null)return Number(exact)||0;
  if(b.feeChargedTo==='both')return Number(b.platformFee)||0;
  return b.feeChargedTo===role?Number(b.platformFee)||0:0;
 };
 const feeStatus=(role,fee)=>{
  if(fee<=0)return 'NO FEE';
  const st=b.feePayments?.[role]?.status;
  if(st==='paid')return 'PAID';
  if(st==='unpaid'||st==='pending'||st==='failed')return 'UNPAID';
  return b.feeChargedTo===role&&b.paymentStatus==='paid'?'PAID':'UNPAID';
 };
 const widths={"Helvetica":[278.0,278.0,355.0,556.0,556.0,889.0,667.0,191.0,333.0,333.0,389.0,584.0,278.0,333.0,278.0,278.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,278.0,278.0,584.0,584.0,584.0,556.0,1015.0,667.0,667.0,722.0,722.0,667.0,611.0,778.0,722.0,278.0,500.0,667.0,556.0,833.0,722.0,778.0,667.0,778.0,722.0,667.0,611.0,722.0,667.0,944.0,667.0,667.0,611.0,278.0,278.0,278.0,469.0,556.0,333.0,556.0,556.0,500.0,556.0,556.0,278.0,556.0,556.0,222.0,222.0,500.0,222.0,833.0,556.0,556.0,556.0,556.0,333.0,500.0,278.0,556.0,500.0,722.0,500.0,500.0,500.0,334.0,260.0,334.0,584.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,278.0,333.0,556.0,556.0,556.0,556.0,260.0,556.0,333.0,737.0,370.0,556.0,584.0,333.0,737.0,333.0,400.0,584.0,333.0,333.0,333.0,556.0,537.0,278.0,333.0,333.0,365.0,556.0,834.0,834.0,834.0,611.0,667.0,667.0,667.0,667.0,667.0,667.0,1000.0,722.0,667.0,667.0,667.0,667.0,278.0,278.0,278.0,278.0,722.0,722.0,778.0,778.0,778.0,778.0,778.0,584.0,778.0,722.0,722.0,722.0,722.0,667.0,667.0,611.0,556.0,556.0,556.0,556.0,556.0,556.0,889.0,500.0,556.0,556.0,556.0,556.0,278.0,278.0,278.0,278.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,584.0,611.0,556.0,556.0,556.0,556.0,500.0,556.0,500.0],"Times-Bold":[250.0,333.0,555.0,500.0,500.0,1000.0,833.0,278.0,333.0,333.0,500.0,570.0,250.0,333.0,250.0,278.0,500.0,500.0,500.0,500.0,500.0,500.0,500.0,500.0,500.0,500.0,333.0,333.0,570.0,570.0,570.0,500.0,930.0,722.0,667.0,722.0,722.0,667.0,611.0,778.0,778.0,389.0,500.0,778.0,667.0,944.0,722.0,778.0,611.0,778.0,722.0,556.0,667.0,722.0,722.0,1000.0,722.0,722.0,667.0,333.0,278.0,333.0,581.0,500.0,333.0,500.0,556.0,444.0,556.0,444.0,333.0,500.0,556.0,278.0,333.0,556.0,278.0,833.0,556.0,500.0,556.0,556.0,444.0,389.0,333.0,556.0,500.0,722.0,500.0,500.0,444.0,394.0,220.0,394.0,520.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,250.0,333.0,500.0,500.0,500.0,500.0,220.0,500.0,333.0,747.0,300.0,500.0,570.0,333.0,747.0,333.0,400.0,570.0,300.0,300.0,333.0,556.0,540.0,250.0,333.0,300.0,330.0,500.0,750.0,750.0,750.0,500.0,722.0,722.0,722.0,722.0,722.0,722.0,1000.0,722.0,667.0,667.0,667.0,667.0,389.0,389.0,389.0,389.0,722.0,722.0,778.0,778.0,778.0,778.0,778.0,570.0,778.0,722.0,722.0,722.0,722.0,722.0,611.0,556.0,500.0,500.0,500.0,500.0,500.0,500.0,722.0,444.0,444.0,444.0,444.0,444.0,278.0,278.0,278.0,278.0,500.0,556.0,500.0,500.0,500.0,500.0,500.0,570.0,500.0,556.0,556.0,556.0,556.0,500.0,556.0,500.0],"Helvetica-Bold":[278.0,333.0,474.0,556.0,556.0,889.0,722.0,238.0,333.0,333.0,389.0,584.0,278.0,333.0,278.0,278.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,556.0,333.0,333.0,584.0,584.0,584.0,611.0,975.0,722.0,722.0,722.0,722.0,667.0,611.0,778.0,722.0,278.0,556.0,722.0,611.0,833.0,722.0,778.0,667.0,778.0,722.0,667.0,611.0,722.0,667.0,944.0,667.0,667.0,611.0,333.0,278.0,333.0,584.0,556.0,333.0,556.0,611.0,556.0,611.0,556.0,333.0,611.0,611.0,278.0,278.0,556.0,278.0,889.0,611.0,611.0,611.0,611.0,389.0,556.0,333.0,611.0,556.0,778.0,556.0,556.0,500.0,389.0,280.0,389.0,584.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,761.0,278.0,333.0,556.0,556.0,556.0,556.0,280.0,556.0,333.0,737.0,370.0,556.0,584.0,333.0,737.0,333.0,400.0,584.0,333.0,333.0,333.0,611.0,556.0,278.0,333.0,333.0,365.0,556.0,834.0,834.0,834.0,611.0,722.0,722.0,722.0,722.0,722.0,722.0,1000.0,722.0,667.0,667.0,667.0,667.0,278.0,278.0,278.0,278.0,722.0,722.0,778.0,778.0,778.0,778.0,778.0,584.0,778.0,722.0,722.0,722.0,722.0,667.0,667.0,611.0,556.0,556.0,556.0,556.0,556.0,556.0,889.0,556.0,556.0,556.0,556.0,556.0,278.0,278.0,278.0,278.0,611.0,611.0,611.0,611.0,611.0,611.0,611.0,584.0,611.0,611.0,611.0,611.0,611.0,556.0,611.0,556.0]};
 const measure=(str,font,size)=>Array.from(str).reduce((n,c)=>n+(widths[font==='F2'?'Times-Bold':font==='F3'?'Helvetica-Bold':'Helvetica'][Math.max(0,Math.min(223,c.charCodeAt(0)-32))]||500),0)*size/1000;
 const ops=[];
 const text=(x,top,size,value,{font='F1',color=WHITE,max=500,align='left'}={})=>{
  const raw=ascii(value);let s=raw;
  while(s.length>1&&measure(s,font,size)>max)s=s.slice(0,-1);
  if(s!==raw){s=s.slice(0,-3).trimEnd()+'...';while(s.length>1&&measure(s,font,size)>max)s=s.slice(0,-4).trimEnd()+'...';}
  const width=measure(s,font,size);
  const xx=align==='center'?x-width/2:align==='right'?x-width:x;
  ops.push(`BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${xx.toFixed(2)} ${(PAGE_H-top).toFixed(2)} Tm (${esc(s)}) Tj ET`);
 };
 const line=(x1,y1,x2,y2,color='.30 .25 .19',w=.45)=>ops.push(`${color} RG ${w} w ${x1} ${PAGE_H-y1} m ${x2} ${PAGE_H-y2} l S`);
 const mid=(y,size,s,opts={})=>text(PAGE_W/2,y,size,s,{...opts,align:'center'});
 // The image contains only the decorative background and authentic brand emblem.
 // All transaction fields, labels and values remain selectable, dynamic PDF text.
 ops.push('q 595 0 0 842 0 0 cm /Bg Do Q');
 const GOLDC='.86 .67 .40',CARD='.075 .068 .058',BORD='.55 .43 .25',TXT='.97 .95 .91',LBL='.80 .70 .52';
 const rect=(x,top,w,h,fill,stroke,lw=.8)=>ops.push(`${fill?fill+' rg ':''}${stroke?stroke+' RG '+lw+' w ':''}${x} ${PAGE_H-top-h} ${w} ${h} re ${fill&&stroke?'B':fill?'f':'S'}`);
 const dot=(cx,top,r,fill)=>{const k=.5523*r,y=PAGE_H-top;ops.push(`${fill} rg ${cx+r} ${y} m ${cx+r} ${y+k} ${cx+k} ${y+r} ${cx} ${y+r} c ${cx-k} ${y+r} ${cx-r} ${y+k} ${cx-r} ${y} c ${cx-r} ${y-k} ${cx-k} ${y-r} ${cx} ${y-r} c ${cx+k} ${y-r} ${cx+r} ${y-k} ${cx+r} ${y} c f`)};
 const sp=s=>s.split(' ').map(w=>w.split('').join(' ')).join('   ');
 const sect=(top,label)=>{text(40,top,9,sp(label),{font:'F3',color:GOLDC});line(40,top+6,555,top+6,BORD,.6)};
 const nm=u=>u.verification?.legalName||u.name||'Not specified';
 // Header
 mid(112,16,'TUTMOVE',{font:'F2',color:GOLDC});
 mid(124,7.5,'VEHICLE TRANSPORT MADE SIMPLE',{color:LBL});
 mid(152,9,sp('FINAL DEAL RECORD'),{font:'F3',color:TXT});
 mid(186,34,'COMPLETED',{font:'F2',color:GOLDC});
 // Parties
 sect(232,'PARTIES');
 const card=(x,role,u,tag)=>{rect(x,244,250,86,CARD,BORD);
  text(x+14,261,8,String(role).toUpperCase(),{font:'F3',color:GOLDC,max:150});
  const tw=measure(tag,'F3',7.5)+14;rect(x+250-14-tw,252,tw,14,GOLDC);text(x+250-14-tw/2,262,7.5,tag,{font:'F3',color:'0 0 0',align:'center'});
  text(x+14,284,15,nm(u),{font:'F2',color:TXT,max:222});
  text(x+14,301,9,u.email,{color:TXT,max:222});
  text(x+14,313,9,u.verification?.phone||u.phone,{color:TXT,max:222});
  text(x+14,325,9,u.verification?.country||u.country,{color:TXT,max:222});};
 card(40,buyerRole,buyer,'PAYS');card(305,providerRole,provider,'RECEIVES');
 // Route
 const LABELS={
  transport:{route:'TRANSPORT ROUTE',from:'PICKUP',to:'DELIVERY',price:'AGREED TRANSPORT PRICE'},
  driver:{route:'WORK LOCATIONS',from:'START',to:'END',price:'AGREED DRIVER COMPENSATION'},
  truck:{route:'RENTAL LOCATIONS',from:'PICKUP',to:'RETURN',price:'AGREED RENTAL PRICE'},
  warehouse:{route:'STORAGE LOCATIONS',from:'START',to:'END',price:'AGREED STORAGE PRICE'},
  equipment:{route:'EQUIPMENT LOCATIONS',from:'PICKUP',to:'RETURN',price:'AGREED EQUIPMENT PRICE'}
 };
 const L=LABELS[b.dealType]||LABELS.transport;
 sect(354,L.route);
 rect(40,366,515,66,CARD,BORD);
 dot(60,384,4,GOLDC);dot(535,384,4,GOLDC);line(66,384,529,384,GOLDC,1);
 text(54,404,8,'FROM  -  '+L.from,{font:'F3',color:GOLDC});text(541,404,8,'TO  -  '+L.to,{font:'F3',color:GOLDC,align:'right'});
 text(54,423,15,route.from,{font:'F2',color:TXT,max:235});text(541,423,15,route.to,{font:'F2',color:TXT,max:235,align:'right'});
 // Price
 sect(456,L.price);
 rect(40,468,515,66,CARD,GOLDC,1.1);
 text(58,512,32,money(b.currency,b.agreedPrice),{font:'F2',color:GOLDC,max:300});
 text(545,490,7.5,'PAID BY',{font:'F3',color:LBL,align:'right'});text(545,502,11,nm(buyer),{font:'F2',color:TXT,align:'right',max:190});
 text(545,517,7.5,'PAID TO',{font:'F3',color:LBL,align:'right'});text(545,529,11,nm(provider),{font:'F2',color:TXT,align:'right',max:190});
 // Fee
 sect(558,'TUTMOVE PLATFORM FEE');
 const fb=feeFor('buyer'),fp=feeFor('provider');
 rect(40,570,515,48,CARD,BORD);
 if(fb<=0&&fp<=0){text(54,590,13,'No platform fee for this deal',{font:'F2',color:TXT,max:480});text(54,606,8.5,'Nothing is owed to TUTMOVE. The agreed price is settled directly between the parties.',{color:LBL,max:490});}
 else{const fr=[];if(fb>0)fr.push([buyerRole,fb,feeStatus('buyer',fb)]);if(fp>0)fr.push([providerRole,fp,feeStatus('provider',fp)]);
  fr.forEach(([r,v,st],i)=>{const yy=(fr.length>1?588:596)+i*18;text(54,yy,10.5,String(r),{font:'F2',color:TXT,max:260});text(430,yy,10.5,money('USD',v),{font:'F2',color:TXT,align:'right'});const ok=st==='PAID';rect(450,yy-10,92,14,ok?GOLDC:'.55 .18 .15');text(496,yy,7.5,st,{font:'F3',color:ok?'0 0 0':'1 1 1',align:'center'});});}
 // Details
 sect(642,'DEAL DETAILS');
 const rows=[['DEAL REFERENCE',b.id],['DEAL TYPE',String(b.dealType||'deal').toUpperCase()],['PAYMENT METHOD',terms.confirmed?terms.settlementMethod:'Not agreed'],['PAYMENT TIMING',terms.confirmed?terms.paymentTiming:'Not agreed'],['CONFIRMATION',b.completion?.buyer&&b.completion?.provider?'Confirmed by both parties':'Completed deal'],['COMPLETED AT',date(b.completedAt)],['ADDITIONAL TERMS',terms.additionalTerms||offer.message||'No additional written terms']];
 let y=654;rows.forEach(([k,v],i)=>{if(i%2===0)rect(40,y,515,17,'.06 .055 .048',null);text(50,y+12,8,String(k),{font:'F3',color:LBL,max:200});text(230,y+12,9.5,v,{color:TXT,max:315});y+=17;});
 text(40,792-14*0,0.1,' ');
 text(40,786,7.5,'TUTMOVE records the agreement and its applicable platform fee only. TUTMOVE is not a party to the underlying transaction.',{color:LBL,max:515});
 text(40,796,7.5,'Identity checks, payment, handover, inspection and fulfilment remain the responsibility of the parties.',{color:LBL,max:515});
 line(40,808,555,808,BORD,.6);
 text(40,824,10,'TUTMOVE.COM',{font:'F2',color:GOLDC});
 text(555,824,8.5,db.settings?.supportEmail||'info@tutmove.com',{color:GOLDC,align:'right',max:200});
 const stream=Buffer.from(ops.join('\n'),'latin1');
 const bg=fs.readFileSync(path.join(__dirname,'deal-record-bg2.jpg'));
 const objs=[null,
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
  Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> /XObject << /Bg 8 0 R >> >> /Contents 4 0 R >>'),
  Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]),
  Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>'),
  Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
  Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1190 /Height 1684 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bg.length} >>\nstream\n`),bg,Buffer.from('\nendstream')])];
 const parts=[Buffer.from('%PDF-1.4\n')],offsets=[0];let at=parts[0].length;
 for(let i=1;i<objs.length;i++){offsets[i]=at;const block=Buffer.concat([Buffer.from(`${i} 0 obj\n`),objs[i],Buffer.from('\nendobj\n')]);parts.push(block);at+=block.length;}
 let trailer=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;
 for(let i=1;i<objs.length;i++)trailer+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
 trailer+=`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF`;
 return Buffer.concat([...parts,Buffer.from(trailer)]);
}
module.exports={createDealRecord,routeFrom};

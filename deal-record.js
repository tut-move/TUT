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
 const buyerRole=clean(b.buyerDealRole||b.partyRoles?.buyer||roles[0]);
 const providerRole=clean(b.providerDealRole||b.partyRoles?.provider||roles[1]);
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
 // Layout coordinates match the decorative background's actual horizontal rules.
 // All centered text uses the real built-in PDF font advance widths.
 mid(104,18,'TUTMOVE',{font:'F2',color:GOLD});
 mid(116,8.1,'VEHICLE TRANSPORT MADE SIMPLE',{color:IVORY});
 mid(148,10.5,'F I N A L   D E A L   R E C O R D',{color:WHITE});
 mid(178,36,'COMPLETED',{font:'F2',color:GOLD});
 mid(190,8.4,'OFFICIAL TUT MOVE TRANSACTION RECORD');
 const party=(x,role,u)=>{
  text(x,244,16,`${u.verification?.legalName||u.name||'Not specified'} (${role.toLowerCase()})`,{font:'F2',color:IVORY,max:235});
  text(x,262,9.3,u.email,{max:225});
  text(x,276,9.3,u.verification?.phone||u.phone,{max:225});
  text(x,288,9.3,u.verification?.country||u.country,{max:225});
 };
 party(48,buyerRole,buyer);party(315,providerRole,provider);
 ops.push('0 0 0 rg 195 515 205 26 re f');
 mid(316,10,'T R A N S P O R T   R O U T E',{color:GOLD});
 text(48,341,9,'PICKUP LOCATION',{color:MUTED});text(315,341,9,'DELIVERY LOCATION',{color:MUTED});
 text(48,361,17,route.from,{font:'F2',color:IVORY,max:226});text(315,361,17,route.to,{font:'F2',color:IVORY,max:226});
 mid(399,10,'A G R E E D   T R A N S P O R T   P R I C E',{color:GOLD});
 mid(431,30,money(b.currency,b.agreedPrice),{font:'F2',color:IVORY,max:340});
 mid(449,8.5,`To be paid by ${buyer.verification?.legalName||buyer.name||'requester'} to ${provider.verification?.legalName||provider.name||'provider'}`,{max:480});
 // Fee snapshot remains per-party and independent of the underlying transport price.
 // Display one clean box with each party's actual recorded fee, not a fabricated paid status.
 mid(490,10,'T U T   M O V E   F E E',{color:GOLD});
 mid(515,18,`Requester: ${money('USD',feeFor('buyer'))}    Provider: ${money('USD',feeFor('provider'))}`,{font:'F2',color:IVORY,max:490});
 mid(537,9,`Fee status: requester ${feeStatus('buyer',feeFor('buyer'))} / provider ${feeStatus('provider',feeFor('provider'))}`,{color:GOLD,max:490});
 text(48,572,15,'D E A L   D E T A I L S',{color:GOLD,font:'F2'});
 const rows=[['DEAL REFERENCE',b.id],['DEAL TYPE',String(b.dealType||'deal').toUpperCase()],['PAYMENT METHOD',terms.confirmed?terms.settlementMethod:'Not agreed'],['PAYMENT TIMING',terms.confirmed?terms.paymentTiming:'Not agreed'],['CONFIRMATION',b.completion?.buyer&&b.completion?.provider?'Confirmed by both parties':'Completed deal'],['COMPLETED AT',date(b.completedAt)],['ADDITIONAL TERMS',terms.additionalTerms||offer.message||'No additional written terms']];
 let y=593;for(const [k,v] of rows){text(48,y,9,k,{color:MUTED,max:210});text(284,y,9.5,v,{max:265});line(45,y+8,550,y+8);y+=19.5;}
 text(48,733,9.2,'TUTMOVE records the agreement and its applicable platform fee only.',{font:'F2',color:GOLD,max:520});
 text(48,744,7.5,'TUTMOVE is not a party to the underlying transaction. Identity checks, payment, handover,',{max:510});
 text(48,753,7.5,'inspection and fulfilment remain the responsibility of the parties.',{max:510});
 text(48,790,11,'TUTMOVE.COM',{font:'F2',color:GOLD});mid(790,7.5,'VEHICLE TRANSPORT MADE SIMPLE');
 text(548,790,8.5,db.settings?.supportEmail||'info@tutmove.com',{color:GOLD,align:'right',max:160});
 const stream=Buffer.from(ops.join('\n'),'latin1');
 const bg=fs.readFileSync(path.join(__dirname,'deal-record-background.jpg'));
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

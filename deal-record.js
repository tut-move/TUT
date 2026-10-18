'use strict';
// Single, dependency-free PDF template used by both download and SMTP attachment.
const fs=require('fs');
const path=require('path');
const GOLD='.83 .61 .30', PALE='.98 .92 .79', WHITE='.95 .94 .91', MUTED='.72 .69 .65';
const clean=v=>String(v===null||v===undefined||v===''?'Not specified':v).replace(/[\r\n\t]+/g,' ').trim();
const esc=v=>clean(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e\xa0-\xff]/g,'?').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const amount=(currency,value)=>`${clean(currency||'USD')} ${Number(value||0).toFixed(2)}`;
const stamp=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})+' UTC':'Not specified';
function routeFrom(listing,offer,booking){
  const sources=[booking,booking?.trip,booking?.dealTerms,listing?.data,listing,listing?.details,offer].filter(Boolean);
  const pick=(keys)=>{for(const s of sources)for(const k of keys)if(typeof s[k]==='string'&&s[k].trim())return s[k].trim();return 'Not specified';};
  return {from:pick(['pickupLocation','pickup','origin','fromLocation','from','startLocation','loadingLocation','pickupAddress','originCity','fromCity','startCity','location']),to:pick(['deliveryLocation','delivery','destination','toLocation','to','endLocation','dropoffLocation','deliveryAddress','destinationCity','toCity','endCity'])};
}
function createDealRecord(booking,db){
 const b=booking,listing=(db.listings||[]).find(x=>x.id===b.listingId)||{},offer=(db.offers||[]).find(x=>x.id===b.offerId)||{};
 const buyer=(db.users||[]).find(x=>x.id===b.buyerUserId)||{},provider=(db.users||[]).find(x=>x.id===b.providerUserId)||{};
 const labels={driver:['REQUESTER','DRIVER'],truck:['REQUESTER','TRUCK / VEHICLE OWNER'],warehouse:['REQUESTER','WAREHOUSE PROVIDER'],equipment:['REQUESTER','EQUIPMENT PROVIDER'],transport:['CARGO OWNER','TRANSPORT PROVIDER']};
 const [buyerRole,providerRole]=labels[b.dealType]||['REQUESTER','PROVIDER'];
 const route=routeFrom(listing,offer,b),terms=b.dealTerms||{};
 const feeFor=(role)=>{const explicit=role==='buyer'?b.customerFeeUSD:b.providerFeeUSD;if(explicit!==undefined&&explicit!==null)return Number(explicit)||0;return b.feeChargedTo===(role==='buyer'?'buyer':'provider')?Number(b.platformFee)||0:0;};
 const feeStatus=(role,val)=>{if(val<=0)return 'NO FEE';const st=b.feePayments?.[role]?.status;if(st==='paid')return 'PAID';if(st==='unpaid'||st==='pending'||st==='failed')return 'UNPAID';return b.paymentStatus==='paid'&&b.feeChargedTo===role?'PAID':'UNPAID';};
 const c=['0.018 0.018 0.018 rg 0 0 595 842 re f'];
 const line=(x1,y,x2,col=GOLD,width=.65)=>c.push(`${col} RG ${width} w ${x1} ${y} m ${x2} ${y} l S`);
 const vertical=(x,y1,y2)=>c.push(`${GOLD} RG .65 w ${x} ${y1} m ${x} ${y2} l S`);
 const txt=(x,y,size,s,font='F1',color=WHITE)=>c.push(`BT /${font} ${size} Tf ${color} rg ${x} ${y} Td (${esc(s)}) Tj ET`);
 const center=(y,size,s,font='F1',color=WHITE)=>{const width=clean(s).length*size*(font==='F2'?.51:.48);txt(Math.max(35,(595-width)/2),y,size,s,font,color)};
 const clipped=(s,n=36)=>clean(s).length>n?clean(s).slice(0,n-3)+'...':clean(s);
 // Reserved logo header: uses the site's actual emblem when available.
 center(757,19,'TUTMOVE','F2',GOLD);center(741,8,'VEHICLE TRANSPORT MADE SIMPLE','F1',PALE);
 line(42,728,553);center(707,10,'FINAL DEAL RECORD','F1',WHITE);center(669,31,'COMPLETED','F2',GOLD);center(651,8,'OFFICIAL TUT MOVE TRANSACTION RECORD');line(42,636,553);
 txt(51,614,9,buyerRole,'F1',GOLD);txt(311,614,9,providerRole,'F1',GOLD);vertical(297,546,619);
 txt(51,592,16,clipped(buyer.verification?.legalName||buyer.name,23),'F2',PALE);txt(311,592,16,clipped(provider.verification?.legalName||provider.name,23),'F2',PALE);
 const party=(x,u)=>{txt(x,573,8,clipped(u.email,37));txt(x,558,8,clipped(u.verification?.phone||u.phone,37));txt(x,544,8,clipped(u.verification?.country||u.country,37))};party(51,buyer);party(311,provider);
 line(42,530,553);center(514,9,'TRANSPORT ROUTE','F1',GOLD);
 txt(51,496,8,'PICKUP LOCATION','F1',MUTED);txt(311,496,8,'DELIVERY LOCATION','F1',MUTED);
 txt(51,476,13,clipped(route.from,30),'F2',PALE);txt(311,476,13,clipped(route.to,30),'F2',PALE);line(42,462,553);
 center(443,9,'AGREED TRANSPORT PRICE','F1',GOLD);center(410,25,amount(b.currency,b.agreedPrice),'F2',PALE);center(396,8,'Paid directly between the parties outside TUT Move');
 line(42,384,553);vertical(297,316,373);
 const fee=(x,role,u,val)=>{txt(x,367,8,role==='buyer'?'TUT MOVE FEE (CUSTOMER)':'TUT MOVE FEE (PROVIDER)','F1',GOLD);txt(x,342,20,amount('USD',val),'F2',PALE);txt(x,326,8,clipped('Charged to '+(u.name||'party'),36));txt(x,311,9,feeStatus(role,val),'F2',GOLD)};
 fee(51,'buyer',buyer,feeFor('buyer'));fee(311,'provider',provider,feeFor('provider'));
 line(42,296,553);txt(51,278,12,'DEAL DETAILS','F2',GOLD);
 const rows=[['DEAL REFERENCE',b.id],['DEAL TYPE',String(b.dealType||'deal').toUpperCase()],['PAYMENT METHOD',terms.settlementMethod],['PAYMENT TIMING',terms.paymentTiming],['CONFIRMATION','Confirmed by both parties'],['COMPLETED AT',stamp(b.completedAt)],['ADDITIONAL TERMS',terms.additionalTerms||offer.message||'No additional written terms']];
 let y=260;for(const [k,v] of rows){txt(51,y,7.5,k,'F1',MUTED);txt(266,y,8,clipped(v,54),'F1',WHITE);line(49,y-7,547,'.34 .30 .24',.35);y-=20}
 txt(51,105,9,'TUT Move records the agreement and its applicable platform fee only.','F2',GOLD);
 txt(51,90,7,'TUT Move is not a party to the underlying transaction. Identity checks, payment, handover,','F1',WHITE);
 txt(51,79,7,'inspection and fulfilment of the agreed terms remain the responsibility of the parties.');
 line(42,62,553);txt(51,43,10,'TUTMOVE.COM','F2',GOLD);txt(228,43,7,'VEHICLE TRANSPORT MADE SIMPLE');txt(433,43,8,clipped(db.settings?.supportEmail||'info@tutmove.com',27),'F1',GOLD);
 // Embed real TUT emblem as an image XObject without requiring a headless browser.
 const imageFile=path.join(__dirname,'deal-record-emblem.jpg');
 const image=fs.existsSync(imageFile)?fs.readFileSync(imageFile):null;
 if(image)c.push('q 57 0 0 57 269 777 cm /Im1 Do Q');
 const stream=Buffer.from(c.join('\n'),'latin1');
 const objects=[null,
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
  Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> '+(image?'/XObject << /Im1 7 0 R >> ':'')+'>> /Contents 4 0 R >>'),
  Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]),
  Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>')];
 if(image)objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 420 /Height 420 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]));
 const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let pos=chunks[0].length;
 for(let i=1;i<objects.length;i++){offsets[i]=pos;const obj=Buffer.concat([Buffer.from(`${i} 0 obj\n`),objects[i],Buffer.from('\nendobj\n')]);chunks.push(obj);pos+=obj.length;}
 const xref=pos;let tail=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(let i=1;i<objects.length;i++)tail+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';tail+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return Buffer.concat([...chunks,Buffer.from(tail)]);
}
module.exports={createDealRecord,routeFrom};

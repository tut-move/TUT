// One source of truth for "who is this person IN THIS DEAL" (driver, warehouse owner, company...).
// Used by the server views, the profile endpoints and the Deal Record PDF so they always agree.
const LABELS={
  driver:   {buyer:'Requester',   provider:'Driver'},
  transport:{buyer:'Cargo owner', provider:'Transport provider'},
  truck:    {buyer:'Renter',      provider:'Truck owner'},
  equipment:{buyer:'Renter',      provider:'Equipment owner'},
  warehouse:{buyer:'Client',      provider:'Warehouse owner'}
};
function isCompany(u){
  const v=u?.verification||{},role=String(v.role||u?.role||'').toLowerCase();
  return !!String(v.registrationNumber||'').trim()||['carrier','transport_company','transport-company','company'].includes(role);
}
function capacityLabel(dealType,side,user){
  const base=(LABELS[dealType]||{buyer:'Requester',provider:'Provider'})[side==='buyer'?'buyer':'provider'];
  return isCompany(user)?`${base} · Company`:base;
}
module.exports={capacityLabel,isCompany,LABELS};

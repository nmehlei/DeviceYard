"use client";
import {useEffect,useState} from 'react';
import {orgScopedFetch} from '../lib/activeOrg';
const editionFetch=orgScopedFetch();
interface Edition {edition:'community'|'pro';state:string;multiDevice:boolean;selectedDeviceId:string|null;expiresAt?:number;graceEndsAt?:number;blockedReason?:string|null;}
export function EditionCard({admin,devices,onChanged=()=>{}}:{admin:boolean;devices:{id:string;label:string}[];onChanged?:()=>void}) {
  const [edition,setEdition]=useState<Edition|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let alive=true;
    const load=async()=>{try{const r=await editionFetch('/api/edition');if(r.status===404)return;if(!r.ok)throw Error('Edition status unavailable');const data=await r.json();if(alive){setEdition(data);setSelected(value=>value||data.selectedDeviceId||'');}}catch{if(alive)setError('Edition status unavailable. Try refreshing.');}};
    void load();const timer=setInterval(load,10000);return()=>{alive=false;clearInterval(timer);};
  },[]);
  const submit=async(route:string,body:Record<string,string>)=>{
    setBusy(true);setError('');
    try{const r=await editionFetch(`/api/edition/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'Could not save edition settings');setEdition(data);onChanged();}
    catch(e){setError(e instanceof Error?e.message:'Could not save edition settings');}finally{setBusy(false);}
  };
  if(!edition)return error?<p role="alert">{error}</p>:null;
  return <section className="ops-box ops-pad mb-5" aria-label="DeviceYard edition">
    <h2>{edition.edition==='pro'?'Pro':'Community'}</h2>
    <p className="ops-muted">{edition.multiDevice?'Device pool and parallel execution enabled.':'One active device per installation. Select a device below to use for tests and remote control.'}</p>
    {edition.state==='grace'&&<p role="status">Renew Pro before {new Date(edition.graceEndsAt!).toLocaleString()}. After the seven-day grace period, running tests finish and new work uses your Community device.</p>}
    {['expired','invalid'].includes(edition.state)&&<p role="status">Pro is {edition.state}. Existing work will finish; new tests use your selected Community device.</p>}
    {!edition.selectedDeviceId&&<p role="status">Choose a Community device. Without a selection, new tests will wait when Pro is unavailable.</p>}
    {edition.blockedReason==='COMMUNITY_DEVICE_UNAVAILABLE'&&<p role="status">Tests are waiting. Enable and connect the selected Community device.</p>}
    {edition.blockedReason==='COMMUNITY_DEVICE_BUSY'&&<p role="status">Tests are waiting for current work or a control session to finish.</p>}
    {edition.expiresAt&&<p className="ops-muted">Subscription expires {new Date(edition.expiresAt).toLocaleString()}.</p>}
    {error&&<p role="alert" className="ui-error">{error}</p>}
    {admin&&<div className="mt-4 space-y-3">
      <label className="block">Community device<select className="ui-input block" value={selected} onChange={e=>setSelected(e.target.value)} disabled={busy}>
        <option value="">Choose a device</option>{devices.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}
      </select></label>
      <p className="ops-muted ops-small">To switch devices, disable scheduling and let tests finish, then close live views. Registration and history are preserved.</p>
      <button className="ui-button" disabled={busy||!selected} onClick={()=>void submit('device',{deviceId:selected})}>Select device</button>
      {edition.edition==='pro'&&<label className="block">Pro license file<input aria-label="Pro license file" type="file" accept=".json,application/json" disabled={busy} onChange={async e=>{
        const file=e.target.files?.[0];e.target.value='';if(!file)return;if(file.size>16384){setError('License file is too large.');return;}
        try{await submit('license',{license:await file.text()});}catch{setError('Could not read the license file.');}
      }}/></label>}
    </div>}
    {!edition.multiDevice&&<p className="mt-3"><a href="mailto:hello@codebakery.net?subject=DeviceYard%20Pro">Ask about Pro — €99 per organisation/year</a></p>}
  </section>;
}

let fixtureConfig=null, fixtureRevision='0', fixtureConflict=false, fixtureDelay=null, fixtureError=null, fixtureOverviewDelay=null, fixtureReadStatus=null;
const fixtureRequests=[];
const fixtureStatus=()=>({version:'1.3.0',startedAt:'2026-10-28T12:00:00Z',community:fixtureConfig?.account.community,readOnly:fixtureConfig?.readOnly??true,read:fixtureReadStatus||{lastCheck:'2026-10-28T14:00:00Z',lastSuccess:'2026-10-28T14:00:00Z',lastError:['auth_required','check_failed'].includes(fixtureError)?fixtureError:null},scheduler:{running:true,lastCheck:'2026-10-28T14:00:00Z',lastSuccess:'2026-10-28T14:00:00Z',nextCheck:'2026-10-28T14:15:00Z',lastError:fixtureError,failedChannels:[],deliveredCount:0}});
const fixtureEnvelope=()=>({revision:fixtureRevision,configured:!!fixtureConfig,config:structuredClone(fixtureConfig),status:fixtureStatus()});
const fixtureReport=()=>({community:fixtureConfig.account.community,matchday:9,now:'2026-10-28T14:00:00Z',timeZone:'Europe/Berlin',matches:[{home:'Freiburg',away:'Dortmund',kickoff:'2026-10-30T19:30:00Z',bet:null,needsBet:true,closed:false},{home:'Frankfurt',away:'Stuttgart',kickoff:'2026-10-31T14:30:00Z',bet:'2:1',needsBet:false,closed:false}],needsBetCount:1});
window.fetch=async(path,options)=>{const body=options.body?JSON.parse(options.body):null;fixtureRequests.push({path,options,body});if(path==='/api/admin/config'&&body&&fixtureDelay)await fixtureDelay;if(options.headers.Authorization!=='Bearer fixture-admin-token')return {ok:false,status:401,json:async()=>({error:'unauthorized'})};let data;
if(path==='/api/admin/config'&&!body)data=fixtureEnvelope();
else if(path==='/api/admin/config'){
 if(fixtureConflict){fixtureConflict=false;return {ok:false,status:409,json:async()=>({error:'config_conflict'})}}
 fixtureConfig??={account:{email:'',community:'',site:'de',hasPassword:false},notifications:{channels:[],warnHours:[],everyMinutes:15},readOnly:true,timeZone:'Europe/Berlin'};
 if(body.account){fixtureConfig.account={...fixtureConfig.account,...body.account,hasPassword:true};delete fixtureConfig.account.password}
 if(body.notifications){fixtureConfig.notifications={...body.notifications,channels:body.notifications.channels.map((c,i)=>({id:c.id||'channel-'+i,kind:c.kind,hasSecret:true,...(c.kind==='telegram'?{chatId:c.chatId}:{})}))}}
 if('timeZone'in body)fixtureConfig.timeZone=body.timeZone;
 if('readOnly'in body)fixtureConfig.readOnly=body.readOnly;
 fixtureRevision=String(Number(fixtureRevision)+1);data=fixtureEnvelope();
}else if(path==='/api/admin/account/check')data={communities:['friends']};
else if(path==='/api/admin/notifications/test')data={ok:true};
else if(path==='/api/admin/overview'||path==='/api/admin/check')data={status:fixtureStatus(),report:fixtureReport()};
else if(path==='/api/admin/connection')data={url:'/mcp',token:'fixture-mcp-token',readOnly:fixtureConfig.readOnly};
else throw Error('unexpected fixture route '+path);
if(path==='/api/admin/overview'&&fixtureOverviewDelay)await fixtureOverviewDelay;
return {ok:true,status:200,json:async()=>structuredClone(data)}};
try{localStorage.removeItem('kicktipp-language')}catch{}

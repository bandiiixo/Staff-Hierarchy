'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG = require('./config');
const CLIENT_ID = CONFIG.discord.clientId;
const CLIENT_SECRET = CONFIG.discord.clientSecret;
const REDIRECT_URI = CONFIG.discord.redirectUri;
const SESSION_SECRET = CONFIG.discord.sessionSecret;
const SUPABASE_URL = CONFIG.supabase.url;
const SUPABASE_SECRET_KEY = CONFIG.supabase.secretKey;
const COOKIE = 'kng_session';
const STATE_COOKIE = 'kng_oauth_state';
const TEAMS = ['gangs','legal','actions','interactions','calls','order','knowledge','discord','tickets','wallstreet'];
const TEAM_LABELS = {
  gangs:'Gangs', legal:'Legal', actions:'Actions', interactions:'Interactions',
  calls:'Calls', order:'Order', knowledge:'Knowledge', discord:'Discord',
  tickets:'Tickets', wallstreet:'WallStreet'
};
const RANKS = ['ADM','AUX','LEAD','SUB-LEAD','MEMBERS','HELPERS'];
const MANAGEMENT_IDS = new Set((CONFIG.discord.managementDiscordIds || []).map(x=>String(x).trim()).filter(Boolean));

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !SESSION_SECRET || SESSION_SECRET.length < 32 || SESSION_SECRET.includes('REPLACE_WITH_')) {
  console.error('Missing Discord OAuth settings or SESSION_SECRET (minimum 32 characters).');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || SUPABASE_SECRET_KEY.includes('PASTE_YOUR_') || SUPABASE_SECRET_KEY.startsWith('sb_publishable_')) {
  console.error('Missing Supabase secret key. Add the secret key for the configured project to config.js (not the publishable key).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

app.set('trust proxy', 1);
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public')));

function b64(value){ return Buffer.from(value).toString('base64url'); }
function sign(value){ return crypto.createHmac('sha256',SESSION_SECRET).update(value).digest('base64url'); }
function safeEqual(a,b){
  const aa=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||''));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function cookieValue(req,name){
  const item=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  if(!item)return null;
  try{return decodeURIComponent(item.slice(name.length+1));}catch{return null;}
}
function setCookie(res,name,value,maxAge){
  const secure=process.env.NODE_ENV==='production'?' Secure':'';
  res.append('Set-Cookie',`${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge};${secure}`);
}
function clearCookie(res,name){
  const secure=process.env.NODE_ENV==='production'?' Secure':'';
  res.append('Set-Cookie',`${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0;${secure}`);
}
function makeSession(user){
  const payload=b64(JSON.stringify({id:String(user.id),username:user.username,global_name:user.global_name||null,avatar:user.avatar||null,exp:Date.now()+7*86400000}));
  return `${payload}.${sign(payload)}`;
}
function getSession(req){
  const token=cookieValue(req,COOKIE); if(!token)return null;
  const parts=token.split('.'); if(parts.length!==2)return null;
  const [payload,signature]=parts;
  if(!safeEqual(signature,sign(payload)))return null;
  try{
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!data.id || data.exp<Date.now())return null;
    return data;
  }catch{return null;}
}
function isManagement(user){return !!user && MANAGEMENT_IDS.has(String(user.id));}
function requireLogin(req,res,next){
  req.user=getSession(req);
  if(!req.user)return res.status(401).json({error:'Log in with Discord to continue.'});
  next();
}
function requireManagement(req,res,next){
  req.user=getSession(req);
  if(!req.user)return res.status(401).json({error:'Log in with Discord to continue.'});
  if(!isManagement(req.user))return res.status(403).json({error:'Management access required.'});
  next();
}
function emptyRoster(){
  const roster={}; for(const rank of RANKS)roster[rank]=[];
  return roster;
}
function validDiscordId(id){return typeof id==='string' && /^\d{17,20}$/.test(id);}
function cleanMember(member){
  return {id:String(member.id),username:String(member.username||''),displayName:String(member.global_name||member.nick||member.username||member.id)};
}
function failDb(error){
  console.error('Supabase error:', error);
  const err=new Error(error?.message || 'Database request failed.');
  err.status=500;
  throw err;
}
async function audit(actor,action,entityType,entityId,oldData,newData){
  const {error}=await supabase.from('permission_audit_log').insert({
    actor_discord_id:String(actor.id),action,entity_type:entityType,
    entity_id:entityId==null?null:String(entityId),
    old_data:oldData??null,new_data:newData??null
  });
  if(error)failDb(error);
}
async function canEditTeam(user,team){
  if(isManagement(user))return true;
  const {data,error}=await supabase.from('team_permissions')
    .select('team_id').eq('staff_discord_id',String(user.id)).eq('team_id',team).maybeSingle();
  if(error)failDb(error);
  return Boolean(data);
}
async function getTeamAccess(discordId){
  const {data,error}=await supabase.from('team_permissions')
    .select('team_id').eq('staff_discord_id',String(discordId));
  if(error)failDb(error);
  return (data||[]).map(row=>row.team_id);
}
async function upsertProfile(user,management=isManagement(user)){
  const {error}=await supabase.from('staff_profiles').upsert({
    discord_id:String(user.id),
    username:String(user.username||'Unknown'),
    display_name:String(user.global_name||user.displayName||user.username||'Unknown'),
    avatar_hash:user.avatar||null,
    is_management:!!management,
    is_active:true,
    last_login_at:new Date().toISOString()
  },{onConflict:'discord_id'});
  if(error)failDb(error);
}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'kng-staff-portal',database:'supabase'}));

app.get('/auth/discord',(req,res)=>{
  const state=crypto.randomBytes(24).toString('hex');
  setCookie(res,STATE_COOKIE,state,600);
  const params=new URLSearchParams({
    client_id:CLIENT_ID, redirect_uri:REDIRECT_URI, response_type:'code',
    scope:'identify', state
  });
  res.redirect('https://discord.com/oauth2/authorize?'+params.toString());
});

app.get('/auth/discord/callback',async(req,res)=>{
  const {code,state,error}=req.query;
  const expected=cookieValue(req,STATE_COOKIE);
  clearCookie(res,STATE_COOKIE);
  if(error || !code || !state || !expected || !safeEqual(state,expected))return res.redirect('/?login=failed');
  try{
    const tokenResponse=await fetch('https://discord.com/api/v10/oauth2/token',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:CLIENT_ID,client_secret:CLIENT_SECRET,grant_type:'authorization_code',
        code:String(code),redirect_uri:REDIRECT_URI
      })
    });
    const tokenData=await tokenResponse.json();
    if(!tokenResponse.ok)throw new Error(tokenData.error_description||'Discord token exchange failed');
    const userResponse=await fetch('https://discord.com/api/v10/users/@me',{
      headers:{Authorization:`Bearer ${tokenData.access_token}`}
    });
    const user=await userResponse.json();
    if(!userResponse.ok || !user.id)throw new Error('Could not retrieve Discord account');
    await upsertProfile(user);
    setCookie(res,COOKIE,makeSession(user),7*86400);
    res.redirect('/');
  }catch(err){console.error('Discord OAuth failed:',err);res.redirect('/?login=failed');}
});

app.get('/api/me',async(req,res,next)=>{
  try{
    const user=getSession(req);
    if(!user)return res.json({authenticated:false});
    await upsertProfile(user);
    const teams=await getTeamAccess(user.id);
    res.json({
      authenticated:true,
      user:{id:user.id,username:user.username,displayName:user.global_name||user.username,avatar:user.avatar},
      management:isManagement(user),teams:isManagement(user)?TEAMS:teams,teamLabels:TEAM_LABELS
    });
  }catch(err){next(err);}
});
app.post('/api/logout',(req,res)=>{clearCookie(res,COOKIE);res.json({ok:true});});

app.get('/api/rosters',requireLogin,async(req,res,next)=>{
  try{
    const {data,error}=await supabase.from('team_members')
      .select('team_id,discord_id,username,display_name,rank,sort_order')
      .order('sort_order',{ascending:true});
    if(error)failDb(error);
    const rosters={}; for(const team of TEAMS)rosters[team]=emptyRoster();
    for(const row of data||[]){
      if(!rosters[row.team_id] || !RANKS.includes(row.rank))continue;
      rosters[row.team_id][row.rank].push({
        id:row.discord_id,username:row.username||'',
        displayName:row.display_name||row.username||row.discord_id
      });
    }
    const access=await getTeamAccess(req.user.id);
    res.json({teams:TEAM_LABELS,rosters,ranks:RANKS,editable:isManagement(req.user)?TEAMS:access,management:isManagement(req.user)});
  }catch(err){next(err);}
});

app.put('/api/rosters/:team',requireLogin,async(req,res,next)=>{
  try{
    const team=req.params.team;
    if(!TEAMS.includes(team))return res.status(404).json({error:'Unknown team.'});
    if(!await canEditTeam(req.user,team))return res.status(403).json({error:'You do not have ADM permission for this team.'});
    const roster=req.body&&req.body.roster;
    if(!roster || typeof roster!=='object')return res.status(400).json({error:'Invalid roster.'});
    const rows=[];
    for(const rank of RANKS){
      const members=roster[rank]||[];
      if(!Array.isArray(members)||members.length>200)return res.status(400).json({error:`Invalid ${rank} list.`});
      for(let i=0;i<members.length;i++){
        const m=members[i];
        if(!m||!validDiscordId(String(m.id)))return res.status(400).json({error:'Every roster member needs a valid Discord ID.'});
        rows.push({
          discord_id:String(m.id),username:String(m.username||'').slice(0,80),
          display_name:String(m.displayName||m.username||m.id).slice(0,80),
          rank,sort_order:i
        });
      }
    }
    const {data:oldRows,error:readError}=await supabase.from('team_members')
      .select('discord_id,username,display_name,rank,sort_order').eq('team_id',team);
    if(readError)failDb(readError);
    const {error}=await supabase.rpc('replace_team_roster',{
      p_team_id:team,p_members:rows,p_actor:String(req.user.id)
    });
    if(error)failDb(error);
    await audit(req.user,'roster.updated','team_roster',team,oldRows,rows);
    const next=emptyRoster();
    for(const row of rows)next[row.rank].push({id:row.discord_id,username:row.username,displayName:row.display_name});
    res.json({ok:true,roster:next});
  }catch(err){next(err);}
});

app.get('/api/management/permissions',requireManagement,async(req,res,next)=>{
  try{
    const {data:perms,error}=await supabase.from('team_permissions')
      .select('team_id,staff_discord_id').order('granted_at',{ascending:true});
    if(error)failDb(error);
    const ids=[...new Set((perms||[]).map(p=>p.staff_discord_id))];
    let profiles=[];
    if(ids.length){
      const result=await supabase.from('staff_profiles')
        .select('discord_id,username,display_name').in('discord_id',ids);
      if(result.error)failDb(result.error);
      profiles=result.data||[];
    }
    const permissions={};
    for(const row of perms||[]){
      if(!permissions[row.staff_discord_id])permissions[row.staff_discord_id]=[];
      permissions[row.staff_discord_id].push(row.team_id);
    }
    res.json({permissions,teams:TEAM_LABELS});
  }catch(err){next(err);}
});

app.put('/api/management/permissions/:userId',requireManagement,async(req,res,next)=>{
  try{
    const userId=String(req.params.userId);
    if(!validDiscordId(userId))return res.status(400).json({error:'Invalid Discord user ID.'});
    if(MANAGEMENT_IDS.has(userId))return res.status(400).json({error:'A management account cannot be changed here.'});
    const teams=req.body&&req.body.teams;
    if(!Array.isArray(teams)||teams.some(t=>!TEAMS.includes(t)))return res.status(400).json({error:'Invalid team permissions.'});
    const uniqueTeams=[...new Set(teams)];
    const {data:oldRows,error:oldError}=await supabase.from('team_permissions')
      .select('team_id').eq('staff_discord_id',userId);
    if(oldError)failDb(oldError);
    const oldTeams=(oldRows||[]).map(r=>r.team_id);
    if(uniqueTeams.length && req.body.username){
      const username=String(req.body.username||req.body.displayName||'Unknown').slice(0,80);
      const displayName=String(req.body.displayName||username).slice(0,80);
      const {error:profileError}=await supabase.from('staff_profiles').upsert({
        discord_id:userId,username,display_name:displayName,is_management:false,is_active:true
      },{onConflict:'discord_id'});
      if(profileError)failDb(profileError);
    }
    const {error:permissionError}=await supabase.rpc('replace_team_permissions',{
      p_staff_discord_id:userId,p_team_ids:uniqueTeams,p_actor:String(req.user.id)
    });
    if(permissionError)failDb(permissionError);
    await audit(req.user,'team_permissions.updated','staff_permissions',userId,oldTeams,uniqueTeams);
    res.json({ok:true,teams:uniqueTeams});
  }catch(err){next(err);}
});

app.get('/api/management/staff-search',requireManagement,async(req,res,next)=>{
  try{
    const query=String(req.query.q||'').trim();
    if(query.length<2)return res.json({members:[]});
    // Bot-free directory: people appear after their first Discord OAuth login.
    // Managers can also enter a Discord user ID directly to allocate access manually.
    if(validDiscordId(query)){
      const {data,error}=await supabase.from('staff_profiles')
        .select('discord_id,username,display_name').eq('discord_id',query).maybeSingle();
      if(error)failDb(error);
      return res.json({members:[data?{
        id:data.discord_id,username:data.username||'Discord user',displayName:data.display_name||data.username||data.discord_id
      }:{id:query,username:'Discord user',displayName:'Manually added Discord user'}]});
    }
    const safe=query.replace(/[,%()]/g,' ').trim();
    const {data,error}=await supabase.from('staff_profiles')
      .select('discord_id,username,display_name')
      .or(`username.ilike.%${safe}%,display_name.ilike.%${safe}%,discord_id.ilike.%${safe}%`)
      .order('display_name',{ascending:true}).limit(25);
    if(error)failDb(error);
    res.json({members:(data||[]).map(row=>({
      id:row.discord_id,username:row.username||'Discord user',displayName:row.display_name||row.username||row.discord_id
    }))});
  }catch(err){next(err);}
});

app.get('/api/chart',requireManagement,async(req,res,next)=>{
  try{
    const {data,error}=await supabase.from('organisation_chart')
      .select('id,role,name,parent_id,sort_order').order('sort_order',{ascending:true});
    if(error)failDb(error);
    const {data:settings,error:settingsError}=await supabase.from('portal_settings')
      .select('setting_key,setting_value').in('setting_key',['chart_title','chart_subtitle']);
    if(settingsError)failDb(settingsError);
    const values=Object.fromEntries((settings||[]).map(x=>[x.setting_key,x.setting_value]));
    res.json({
      title:values.chart_title||'KNG ESTATE',
      subtitle:values.chart_subtitle||'Organisation structure',
      nodes:(data||[]).map(n=>({id:n.id,role:n.role,name:n.name,parentId:n.parent_id}))
    });
  }catch(err){next(err);}
});

app.put('/api/chart',requireManagement,async(req,res,next)=>{
  try{
    const chart=req.body;
    if(!chart||!Array.isArray(chart.nodes)||chart.nodes.length>500)return res.status(400).json({error:'Invalid chart data.'});
    const ids=new Set();
    for(const node of chart.nodes){
      if(!node||typeof node.id!=='string'||typeof node.role!=='string'||typeof node.name!=='string')return res.status(400).json({error:'Each position needs a role and name.'});
      if(ids.has(node.id))return res.status(400).json({error:'Duplicate position ID.'});
      ids.add(node.id);
    }
    for(const node of chart.nodes){
      if(node.parentId!==null&&!ids.has(node.parentId))return res.status(400).json({error:'A parent position could not be found.'});
      let current=node;const seen=new Set([node.id]);
      while(current.parentId){
        if(seen.has(current.parentId))return res.status(400).json({error:'Positions cannot be placed underneath themselves.'});
        seen.add(current.parentId);current=chart.nodes.find(n=>n.id===current.parentId);if(!current)break;
      }
    }
    const {data:oldRows,error:oldError}=await supabase.from('organisation_chart').select('id,role,name,parent_id,sort_order');
    if(oldError)failDb(oldError);
    const nodes=chart.nodes.map((n,i)=>({
      id:n.id,role:n.role.slice(0,100),name:n.name.slice(0,100),
      parent_id:n.parentId||null,sort_order:i+1
    }));
    const {error}=await supabase.rpc('replace_organisation_chart',{
      p_nodes:nodes,p_actor:String(req.user.id)
    });
    if(error)failDb(error);
    await audit(req.user,'organisation_chart.updated','organisation_chart','all',oldRows,nodes);
    res.json({ok:true});
  }catch(err){next(err);}
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  console.error('Request failed:',err);
  res.status(err.status||500).json({error:err.status?err.message:'Something went wrong while processing that request.'});
});

app.listen(PORT,()=>console.log(`KNG Staff Portal running on port ${PORT}`));

const $=id=>document.getElementById(id);
const TEAM_NAMES={gangs:'Gangs',legal:'Legal',actions:'Actions',interactions:'Interactions',calls:'Calls',order:'Order',knowledge:'Knowledge',discord:'Discord',tickets:'Tickets',wallstreet:'WallStreet'};
const RANKS=['ADM','AUX','LEAD','SUB-LEAD','MEMBERS','HELPERS'];
const RANK_LABELS={
  gangs:'GANG MEMBERS', legal:'LEGAL MEMBERS', actions:'ACTION MEMBERS',
  interactions:'INTERACTION MEMBERS', calls:'CALL MEMBERS', order:'ORDER MEMBERS',
  knowledge:'KNOWLEDGE MEMBERS', discord:'DISCORD MEMBERS',
  tickets:'TICKETS MEMBERS', wallstreet:'WALLSTREET MEMBERS'
};
let me=null,rosters={},editable=[],management=false,currentTeam=null,permissions={},chart=null,selectedNode=null,editingNode=null,toastTimer;
async function api(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  let body={};try{body=await response.json()}catch{}
  if(!response.ok)throw new Error(body.error||`Request failed (${response.status})`);
  return body;
}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2800)}
function esc(value=''){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function openMenu(){ $('sidebar').classList.add('open');$('scrim').classList.add('show');$('menuToggle').setAttribute('aria-expanded','true') }
function closeMenu(){ $('sidebar').classList.remove('open');$('scrim').classList.remove('show');$('menuToggle').setAttribute('aria-expanded','false') }
$('menuToggle').addEventListener('click',openMenu);$('closeMenu').addEventListener('click',closeMenu);$('scrim').addEventListener('click',closeMenu);
$('homeLink').addEventListener('click',e=>{e.preventDefault();showHome();closeMenu()});
$('mainNav').addEventListener('click',e=>{
 const team=e.target.closest('[data-team]')?.dataset.team;
 const page=e.target.closest('[data-page]')?.dataset.page;
 if(team)showRoster(team);else if(page==='home')showHome();else if(page==='management')showManagement();else if(page==='organisation')showOrganisation();
 if(team||page)closeMenu();
});
function setActive(selector){document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));const el=document.querySelector(selector);if(el)el.classList.add('active')}
function setUserArea(){
 if(!me){$('userArea').innerHTML='<a class="button button-primary" href="/auth/discord">Login with Discord</a>';return}
 const avatar=me.user.avatar?`https://cdn.discordapp.com/avatars/${me.user.id}/${me.user.avatar}.png?size=64`:'';
 $('userArea').innerHTML=`<div class="user-chip">${avatar?`<img class="avatar" src="${avatar}" alt="">`:'<span class="avatar"></span>'}<span>${esc(me.user.displayName)}</span><button class="button button-quiet" id="logoutBtn">Log out</button></div>`;
 $('logoutBtn').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});location.reload()});
}
function pageHeading(kicker,title,description,actions=''){return `<div class="page-heading"><div><div class="kicker">${kicker}</div><h2>${title}</h2><p>${description}</p></div>${actions}</div>`}
function loginPrompt(){ $('hero').hidden=true;$('pageContent').innerHTML=`<div class="panel login-panel"><div class="kicker">KNG ESTATE ACCESS</div><h2>Staff access required</h2><p>Sign in using your Discord account to view the team workspace. Management permissions are assigned inside the portal.</p><a class="button button-primary" href="/auth/discord">Continue with Discord</a></div>`}
async function init(){
 try{
  me=await api('/api/me');setUserArea();
  if(!me.authenticated){loginPrompt();return}
  management=me.management;$('managementNav').hidden=!management;$('hero').hidden=false;
  await loadRosters();showHome();
  if(new URLSearchParams(location.search).get('login')==='failed')toast('Discord login failed. Please try again.');
 }catch(err){$('pageContent').innerHTML=`<div class="panel notice">${esc(err.message)}</div>`}
}
async function loadRosters(){const data=await api('/api/rosters');rosters=data.rosters;editable=data.editable;management=data.management}
function showHome(){
 setActive('[data-page="home"]');$('hero').hidden=false;
 const count=Object.values(rosters).reduce((sum,r)=>sum+RANKS.reduce((s,k)=>s+(r[k]||[]).length,0),0);
 $('pageContent').innerHTML=pageHeading('WORKSPACE OVERVIEW','Welcome back','Select a team to view its roster and manage staff where you have permission.')+
 `<div class="overview-grid"><div class="stat-card"><strong>${Object.keys(TEAM_NAMES).length}</strong><span>TEAMS</span></div><div class="stat-card"><strong>${count}</strong><span>ROSTER ENTRIES</span></div><div class="stat-card"><strong>${management?'ALL':editable.length}</strong><span>EDITABLE TEAMS</span></div></div>
 <div class="team-grid">${Object.entries(TEAM_NAMES).map(([key,name])=>{const total=RANKS.reduce((s,r)=>s+(rosters[key]?.[r]?.length||0),0);return `<button class="team-card" data-open-team="${key}"><span><strong>${name}</strong><small>${total} roster members ${editable.includes(key)?'· EDIT ACCESS':'· VIEW ONLY'}</small></span><span class="arrow">›</span></button>`}).join('')}</div>`;
 $('pageContent').querySelectorAll('[data-open-team]').forEach(b=>b.addEventListener('click',()=>showRoster(b.dataset.openTeam)));
}
function discordMention(id){return `<@${esc(id)}>`}
function renderMember(member,team,rank,index,canEdit){
 return `<div class="member-row"><code>${discordMention(member.id)}</code>${member.displayName?`<span class="member-name">${esc(member.displayName)}</span>`:''}${canEdit?`<div class="member-actions"><button class="icon-button" data-remove="${rank}|${index}" title="Remove member">Remove</button></div>`:''}</div>`;
}
function showRoster(team){
 currentTeam=team;setActive(`[data-team="${team}"]`);$('hero').hidden=true;
 const canEdit=editable.includes(team)||management;
 const roster=rosters[team]||{};
 $('pageContent').innerHTML=pageHeading('TEAM ROSTER',TEAM_NAMES[team],canEdit?'Manage the team structure and Discord member assignments.':'View the current team roster. You do not have edit permission for this team.',`<span class="tag">${canEdit?'ADM ACCESS':'VIEW ONLY'}</span>`)+
 `<div class="panel"><div class="roster-groups">${RANKS.map(rank=>{const list=roster[rank]||[];return `<section class="rank-card"><div class="rank-head"><h3>${rank==='MEMBERS'?(RANK_LABELS[team]||'TEAM MEMBERS'):rank}</h3><span class="rank-count">${list.length} ${list.length===1?'member':'members'}</span></div><div class="member-list">${list.length?list.map((m,i)=>renderMember(m,team,rank,i,canEdit)).join(''):`<div class="member-empty">No members assigned yet.</div>`}</div>${canEdit?`<form class="add-member" data-add-rank="${rank}"><input name="discordId" placeholder="Discord ID (17–20 digits)" inputmode="numeric" pattern="[0-9]{17,20}" required><input name="displayName" placeholder="Display name (optional)"><button class="button button-primary" type="submit">Add</button></form>`:''}</section>`}).join('')}</div>
 <div class="panel-footer"><span>DISCORD-READY ROSTER FORMAT</span><button class="button button-quiet" id="copyRoster">Copy full roster</button></div></div>`;
 if(canEdit){
  $('pageContent').querySelectorAll('[data-add-rank]').forEach(form=>form.addEventListener('submit',async e=>{
   e.preventDefault();const fd=new FormData(form);const id=String(fd.get('discordId')).trim();
   if(!/^\d{17,20}$/.test(id))return toast('Enter a valid Discord ID.');
   const rank=form.dataset.addRank;const list=rosters[team][rank]||[];
   if(RANKS.some(r=>(rosters[team][r]||[]).some(m=>m.id===id)))return toast('That Discord account is already on this roster.');
   list.push({id,username:'',displayName:String(fd.get('displayName')||'').trim()||id});
   await saveRoster(team);showRoster(team);
  }));
  $('pageContent').querySelectorAll('[data-remove]').forEach(btn=>btn.addEventListener('click',async()=>{
   const [rank,index]=btn.dataset.remove.split('|');rosters[team][rank].splice(Number(index),1);await saveRoster(team);showRoster(team);
  }));
 }
 $('copyRoster').addEventListener('click',()=>{
  const text=RANKS.map(rank=>{const list=roster[rank]||[];return `**${rank==='MEMBERS'?(RANK_LABELS[team]||'TEAM MEMBERS'):rank} (${list.length})**\n\n${list.map(m=>`➢ ${discordMention(m.id)}`).join('\n')||'➢ '}`}).join('\n\n');
  navigator.clipboard.writeText(`## ${TEAM_NAMES[team].toUpperCase()} TEAM MEMBERS LIST\n\n${text}`).then(()=>toast('Discord-formatted roster copied.')).catch(()=>toast('Could not access clipboard.'));
 });
}
async function saveRoster(team){
 try{const result=await api(`/api/rosters/${team}`,{method:'PUT',body:JSON.stringify({roster:rosters[team]})});rosters[team]=result.roster;toast('Roster saved for everyone.')}
 catch(err){toast(err.message);await loadRosters()}
}
async function showManagement(){
 if(!management)return;
 setActive('[data-page="management"]');$('hero').hidden=true;
 $('pageContent').innerHTML=pageHeading('MANAGEMENT CONSOLE','Staff & permissions','Allocate team ADM permissions without installing a Discord bot.')+
 `<div class="permission-layout"><section class="panel"><div class="kicker">STAFF SEARCH</div><h3>Find a staff account</h3><p class="hint">Search people who have logged into the portal, or enter a Discord user ID manually. No server bot required.</p><form id="staffSearch" class="search-row"><input name="q" placeholder="Username, display name or Discord ID…" minlength="2" required><button class="button button-primary">Search</button></form><div id="searchResults" class="search-results"></div></section>
 <section class="panel"><div class="kicker">CURRENT ACCESS</div><h3>Team ADM assignments</h3><p class="hint">Select a person from search to allocate or remove their team permissions.</p><div id="permissionList" class="permission-list">Loading permissions…</div></section></div>`;
 await loadPermissions();
 $('staffSearch').addEventListener('submit',async e=>{
  e.preventDefault();const q=new FormData(e.currentTarget).get('q');$('searchResults').innerHTML='<div class="loading"><span class="spinner"></span>Searching registered staff…</div>';
  try{const result=await api(`/api/management/staff-search?q=${encodeURIComponent(q)}`);$('searchResults').innerHTML=result.members.length?result.members.map(m=>`<div class="staff-result"><div class="staff-meta"><strong>${esc(m.displayName)}</strong><small>${esc(m.username)} · ${m.id}</small></div><button class="button button-quiet" data-select-staff="${m.id}" data-name="${esc(m.displayName)}" data-username="${esc(m.username)}">Manage access</button></div>`).join(''):'<div class="notice">No matching server members found.</div>';
   $('searchResults').querySelectorAll('[data-select-staff]').forEach(b=>b.addEventListener('click',()=>selectStaff(b.dataset.selectStaff,b.dataset.name,b.dataset.username)));
  }catch(err){$('searchResults').innerHTML=`<div class="notice">${esc(err.message)}</div>`}
 });
}
async function loadPermissions(){
 const data=await api('/api/management/permissions');permissions=data.permissions;
 const ids=Object.keys(permissions);
 $('permissionList').innerHTML=ids.length?ids.map(id=>`<div class="permission-person"><div class="permission-person-top"><div><strong>${esc(id)}</strong><br><small>Discord account</small></div><button class="icon-button" data-edit-perm="${id}">Edit</button></div><div class="permission-tags">${permissions[id].map(t=>`<span class="tag">${TEAM_NAMES[t]}</span>`).join('')}</div></div>`).join(''):'<div class="member-empty">No team ADM permissions have been allocated yet.</div>';
 $('permissionList').querySelectorAll('[data-edit-perm]').forEach(b=>b.addEventListener('click',()=>selectStaff(b.dataset.editPerm,'Discord user','')));
}
async function selectStaff(id,name,username=''){
 const current=permissions[id]||[];
 $('searchResults').innerHTML=`<div class="panel" style="padding:14px"><div class="kicker">ALLOCATE TEAM ACCESS</div><h3>${esc(name)}</h3><small>${esc(id)}</small><div class="team-permissions">${Object.entries(TEAM_NAMES).map(([key,label])=>`<label class="check-team"><input type="checkbox" value="${key}" ${current.includes(key)?'checked':''}>${label}</label>`).join('')}</div><button class="button button-primary" id="savePermissions">Save permissions</button> <button class="button button-quiet" id="revokePermissions">Revoke all</button></div>`;
 $('savePermissions').addEventListener('click',async()=>{
  const teams=[...$('searchResults').querySelectorAll('input:checked')].map(x=>x.value);
  try{await api(`/api/management/permissions/${id}`,{method:'PUT',body:JSON.stringify({teams,username,displayName:name})});toast('ADM permissions updated.');await loadPermissions();}catch(err){toast(err.message)}
 });
 $('revokePermissions').addEventListener('click',async()=>{
  try{await api(`/api/management/permissions/${id}`,{method:'PUT',body:JSON.stringify({teams:[]})});toast('All team ADM permissions revoked.');await loadPermissions();}catch(err){toast(err.message)}
 });
}
async function showOrganisation(){
 if(!management)return;
 setActive('[data-page="organisation"]');$('hero').hidden=true;
 try{chart=await api('/api/chart');renderOrganisation()}catch(err){$('pageContent').innerHTML=`<div class="notice">${esc(err.message)}</div>`}
}
function childrenOf(id){return chart.nodes.filter(n=>n.parentId===id)}
let expandedChartNodes=new Set();
function treeNode(node,root=false){
 const kids=childrenOf(node.id),isOpen=expandedChartNodes.has(node.id);
 return `<li class="tree-item ${root?'tree-root':''} ${isOpen?'is-open':''}"><div class="tree-node-row">${kids.length?`<button class="tree-toggle" data-toggle-node="${esc(node.id)}" aria-expanded="${isOpen}">${isOpen?'−':'+'}</button>`:`<span class="tree-toggle-placeholder"></span>`}<button class="node ${root?'root-node':''}" data-node="${esc(node.id)}"><strong>${esc(node.role)}</strong>${node.name?`<span class="person">${esc(node.name)}</span>`:''}</button></div>${kids.length?`<ul ${isOpen?'':'hidden'}>${kids.map(n=>treeNode(n)).join('')}</ul>`:''}</li>`
}
function renderOrganisation(){
 const roots=chart.nodes.filter(n=>n.parentId===null);
 if(!expandedChartNodes.size)roots.forEach(n=>expandedChartNodes.add(n.id));
 $('pageContent').innerHTML=`<div class="org-titlebar"><h1>KNG <em>ORGANISATION</em></h1></div><div class="panel org-panel"><div class="org-toolbar"><div><strong>Leadership structure</strong><small>Choose a branch to reveal positions beneath it. Select a role to edit.</small></div><div class="form-actions"><button class="button button-primary" id="addPosition">Add position</button><button class="button button-quiet" id="expandChart">Expand all</button><button class="button button-quiet" id="collapseChart">Collapse all</button><button class="button button-quiet" id="exportChart">Export</button></div></div><div class="chart-panel"><ul class="tree">${roots.map(n=>treeNode(n,true)).join('')}</ul></div><div id="chartEditor" class="notice">Select a position to edit it, or add a new one.</div></div>`;
 $('pageContent').querySelectorAll('[data-node]').forEach(b=>b.addEventListener('click',()=>editPosition(b.dataset.node)));
 $('pageContent').querySelectorAll('[data-toggle-node]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.toggleNode;expandedChartNodes.has(id)?expandedChartNodes.delete(id):expandedChartNodes.add(id);renderOrganisation()}));
 $('expandChart').addEventListener('click',()=>{chart.nodes.forEach(n=>{if(childrenOf(n.id).length)expandedChartNodes.add(n.id)});renderOrganisation()});
 $('collapseChart').addEventListener('click',()=>{expandedChartNodes.clear();renderOrganisation()});
 $('addPosition').addEventListener('click',()=>editPosition(null));
 $('exportChart').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(chart,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='kng-organisation-chart.json';a.click();URL.revokeObjectURL(a.href)});
}
function editPosition(id){
 editingNode=id?chart.nodes.find(n=>n.id===id):null;
 const parentOptions=chart.nodes.filter(n=>!editingNode||n.id!==id).map(n=>`<option value="${esc(n.id)}" ${editingNode?.parentId===n.id?'selected':''}>${esc(n.role)}</option>`).join('');
 $('chartEditor').innerHTML=`<h3>${editingNode?'Edit position':'Add position'}</h3><form id="chartForm"><label class="form-label">Role title<input class="field" name="role" required maxlength="60" value="${esc(editingNode?.role||'')}"></label><label class="form-label">Name<input class="field" name="name" maxlength="80" value="${esc(editingNode?.name||'')}"></label><label class="form-label">Reports to<select class="field" name="parent"><option value="">Top level</option>${parentOptions}</select></label><div class="form-actions"><button class="button button-primary">Save</button>${editingNode?'<button type="button" class="button button-danger" id="deleteNode">Delete</button>':''}</div></form>`;
 $('chartForm').addEventListener('submit',async e=>{
  e.preventDefault();const fd=new FormData(e.currentTarget);const parent=fd.get('parent')||null;
  if(editingNode){editingNode.role=String(fd.get('role'));editingNode.name=String(fd.get('name'));editingNode.parentId=parent}
  else chart.nodes.push({id:'position-'+Date.now(),role:String(fd.get('role')),name:String(fd.get('name')),parentId:parent});
  try{await api('/api/chart',{method:'PUT',body:JSON.stringify(chart)});toast('Organisation chart saved.');showOrganisation()}catch(err){toast(err.message)}
 });
 if(editingNode)$('deleteNode').addEventListener('click',async()=>{
  const remove=new Set([editingNode.id]);let changed=true;while(changed){changed=false;chart.nodes.forEach(n=>{if(remove.has(n.parentId)&&!remove.has(n.id)){remove.add(n.id);changed=true}})}
  if(!confirm(`Delete this position and ${remove.size-1} position(s) beneath it?`))return;
  chart.nodes=chart.nodes.filter(n=>!remove.has(n.id));
  try{await api('/api/chart',{method:'PUT',body:JSON.stringify(chart)});toast('Position deleted.');showOrganisation()}catch(err){toast(err.message)}
 });
}
init();

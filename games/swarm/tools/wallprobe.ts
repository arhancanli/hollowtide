import { FIXED_STEP } from '@arcade/core';
import { World } from '../src/sim/world.js';
import { CHARACTERS } from '../src/content/characters.js';
import { WEAPONS } from '../src/content/weapons.js';
import { BOSS_SCHEDULE } from '../src/content/balance.js';
function makeRng(seed:number){let s=seed>>>0||1;return()=>{s=(s+0x6d2b79f5)|0;let t=s;t=Math.imul(t^(t>>>15),1|t);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function run(seed:number,ci:number,f:Record<string,number>,m:number,a:number){
  const w=new World(seed); w.setForge(f); w.setMastery(m); w.setAscension(a);
  w.reset(seed,CHARACTERS[ci]!); w.setView(240,498);
  const rng=makeRng(seed^0x5bf03635); const st={h:rng()*6.28,cd:0};
  let lastBoss=''; let lastBossAt=-1;
  for(let i=0;i<Math.ceil(900/FIXED_STEP);i++){
    if(w.phase==='levelup'&&w.pendingCards){const cs=w.pendingCards;
      const ev=cs.find(c=>c.kind==='evolution');
      const en=cs.find(c=>c.kind==='passive'&&w.player.weapons.some(x=>WEAPONS[x.id].evolveWith===c.passiveId));
      const lv=cs.find(c=>c.kind==='weapon'&&c.levelLabel!=='');
      const fr=cs.find(c=>c.kind==='weapon'&&c.levelLabel==='');
      w.chooseUpgrade((ev??en??lv??fr??cs[0]!).id); continue;}
    if(w.phase==='boon'&&w.pendingBoons){w.chooseBoon(w.pendingBoons[0]!); continue;}
    if(w.phase==='dead') break;
    st.cd-=FIXED_STEP;
    if(st.cd<=0){st.cd=0.22;const p=w.player;let cx=0,cy=0,n=0;const l=w.enemies.active;
      for(let j=0;j<l.length;j++){const e=l[j]!;if(e.hp<=0)continue;const dx=e.x-p.x,dy=e.y-p.y;if(dx*dx+dy*dy>190*190)continue;cx+=dx;cy+=dy;n++;}
      st.h=n>0?Math.atan2(-cy,-cx)+(rng()-0.5)*1.1:st.h+(rng()-0.5)*1.2;}
    w.input.x=Math.cos(st.h); w.input.y=Math.sin(st.h);
    w.step(FIXED_STEP);
    for(const ev of w.events){ if(ev.type==='bossSpawned'){lastBoss=(ev as any).name; lastBossAt=w.time;} }
    w.clearEvents();
  }
  return {t:w.time,boss:lastBoss,since:lastBossAt<0?-1:w.time-lastBossAt, bossAlive: w.activeBoss!=null};
}
const MAX={might:5,vitality:5,haste:5,reach:5,swiftness:5,magnet:5,greed:5,growth:5};
for(const [name,f,m,a] of [['FRESH tier0',{},0,0],['MAXED tier0',MAX,10,0],['MAXED tier8',MAX,10,8]] as [string,Record<string,number>,number,number][]){
  const rows=[] as {t:number,boss:string,since:number,alive:boolean}[];
  for(let ci=0;ci<6;ci++)for(let s=0;s<8;s++) rows.push(run(3000+s*104729+ci*7919,ci,f,m,a) as any);
  const byBoss=new Map<string,number>();
  for(const r of rows) byBoss.set(r.boss||'(none)', (byBoss.get(r.boss||'(none)')??0)+1);
  const past=(x:number)=>rows.filter(r=>r.t>=x).length;
  console.log(`\n${name}  n=${rows.length}`);
  console.log(`  died with a boss on screen: ${(rows.filter(r=>r.alive).length/rows.length*100).toFixed(0)}%   median seconds after last boss spawn: ${rows.map(r=>r.since).sort((a,b)=>a-b)[Math.floor(rows.length/2)]!.toFixed(0)}s`);
  console.log(`  last boss seen: ${[...byBoss.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${(v/rows.length*100).toFixed(0)}%`).join('  ')}`);
  for(const b of BOSS_SCHEDULE) console.log(`    reach ${String(b.t).padStart(3)}s (${b.name}): ${(past(b.t)/rows.length*100).toFixed(0)}%`);
}

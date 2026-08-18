import { FIXED_STEP } from '@arcade/core';
import { World } from '../src/sim/world.js';
import { CHARACTERS } from '../src/content/characters.js';
import { WEAPONS } from '../src/content/weapons.js';
import { goldFor } from '../src/content/unlocks.js';
import { masteryFor } from '../src/content/mastery.js';
type S='novice'|'average'|'good';
const SK:Record<S,{r:number;e:number;rad:number}>={novice:{r:0.42,e:1.1,rad:150},average:{r:0.22,e:0.55,rad:190},good:{r:0.1,e:0.25,rad:220}};
function makeRng(seed:number){let s=seed>>>0||1;return()=>{s=(s+0x6d2b79f5)|0;let t=s;t=Math.imul(t^(t>>>15),1|t);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function run(seed:number,ci:number,sk:S,f:Record<string,number>,m:number,a:number){
  const w=new World(seed); w.setForge(f); w.setMastery(m); w.setAscension(a);
  w.reset(seed,CHARACTERS[ci]!); w.setView(240,498);
  const rng=makeRng(seed^0x5bf03635); const st={h:rng()*6.28,cd:0}; const cfg=SK[sk];
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
    if(st.cd<=0){st.cd=cfg.r;const p=w.player;let cx=0,cy=0,n=0;const l=w.enemies.active;
      for(let j=0;j<l.length;j++){const e=l[j]!;if(e.hp<=0)continue;const dx=e.x-p.x,dy=e.y-p.y;if(dx*dx+dy*dy>cfg.rad*cfg.rad)continue;cx+=dx;cy+=dy;n++;}
      st.h=n>0?Math.atan2(-cy,-cx)+(rng()-0.5)*2*cfg.e:st.h+(rng()-0.5)*1.2;}
    w.input.x=Math.cos(st.h); w.input.y=Math.sin(st.h); w.step(FIXED_STEP); w.clearEvents();
  }
  return {t:w.time,k:w.kills,l:w.level};
}
function med(x:number[]){const s=x.slice().sort((a,b)=>a-b);return s[Math.floor(s.length/2)]!;}
function pc(x:number[],p:number){const s=x.slice().sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.max(0,Math.round(p/100*(s.length-1))))]!;}
for(const sk of ['novice','average','good'] as S[]){
  const golds:number[]=[],times:number[]=[],kills:number[]=[],mast:number[]=[],share:number[]=[];
  for(let ci=0;ci<6;ci++)for(let s=0;s<5;s++){
    const r=run(2000+s*104729+ci*7919,ci,sk,{},0,0);
    const g=goldFor(r.t,r.k,r.l);
    golds.push(g);times.push(r.t);kills.push(r.k);
    mast.push(masteryFor(r.t,r.k,r.l,1));
    share.push((r.k*0.8)/g);
  }
  console.log(`${sk.padEnd(8)} n=${golds.length} medTime=${med(times).toFixed(0)}s medKills=${med(kills)} medGold=${med(golds)} medMasteryXp=${med(mast)} killShareOfGold=${(med(share)*100).toFixed(0)}%`);
  console.log(`         gold p10=${pc(golds,10)} p25=${pc(golds,25)} p50=${pc(golds,50)} p75=${pc(golds,75)} p90=${pc(golds,90)}  >=6000g(all six chars): ${(golds.filter(g=>g>=6000).length/golds.length*100).toFixed(0)}% of FIRST runs  >=250g(LANCE): ${(golds.filter(g=>g>=250).length/golds.length*100).toFixed(0)}%`);
  const cum=[...golds].sort((a,b)=>b-a); let acc=0,r=0; while(acc<37840&&r<cum.length){acc+=med(golds);r++;} 
  console.log(`         runs to 37,840g at median payout (no GREED, no ascension): ${r}`);
}

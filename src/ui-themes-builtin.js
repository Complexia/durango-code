// Prebuilt themes for Settings → Themes. Plain data in the format of
// src/ui-themes.js (sanitizeTheme passes every field through unchanged).
//
// Each animated backdrop is a self-contained canvas scene: no network, no
// external files, devicePixelRatio capped at 1.5, the same frame rate focused
// or not (the app freezes scenes a while after it loses focus), nothing drawn
// while the document is hidden, one still frame when reduced motion is on.
// Scenes listen to the app through
// `window.durango` (THEME_SCENE_EVENTS): `working` eases them into a busier
// state over about a second, a finished turn (or Preview celebration) plays a
// short celebration.
//
// The scene code below is written for template literals: no backticks and no
// dollar-brace sequences inside it.

// Shared scene loop: sizing (re-checked every frame and on ResizeObserver: a
// frame can start at 1x1 before layout and get no resize event), frame pacing, focus/visibility/reduced motion,
// eased `wk` (0..1 while working) and `onDone(fn)` for celebrations. A scene
// defines `onSize()` and `draw(dt, still)` and uses X (2D context), W, H, T.
// A scene may set MF (minimum ms between frames, e.g. 30 for ~30 fps).
const LOOP = `var D=window.durango,cv=document.getElementById("c"),X=cv.getContext("2d"),W=1,H=1,R=1,T=0,wk=0,wl=0,last=0,raf=0,tmo=0,dirty=1,rm=0,MF=0;
function rnd(a,b){return a+Math.random()*(b-a);}
function fit(){R=Math.min(1.5,window.devicePixelRatio||1);W=Math.max(1,innerWidth);H=Math.max(1,innerHeight);cv.width=Math.round(W*R);cv.height=Math.round(H*R);cv.style.width=W+"px";cv.style.height=H+"px";X.setTransform(R,0,0,R,0,0);dirty=1;onSize();}
function kick(){if(!raf&&!tmo)raf=requestAnimationFrame(tick);}
function tick(now){raf=0;if(document.hidden){last=0;return;}var s=D.state;if(Math.max(1,innerWidth)!==W||Math.max(1,innerHeight)!==H)fit();
if(s.reducedMotion){if(!rm){rm=1;dirty=1;}if(dirty){dirty=0;wl=wk=s.working?1:0;X.setTransform(R,0,0,R,0,0);draw(0,1);}last=0;tmo=setTimeout(function(){tmo=0;kick();},500);return;}rm=0;
var gap=MF;if(gap&&last&&now-last<gap){raf=requestAnimationFrame(tick);return;}
var dt=last?Math.min(0.1,(now-last)/1000):0.016;last=now;T+=dt;
wl=Math.max(0,Math.min(1,wl+(s.working?dt:-dt)*0.9));wk=wl*wl*(3-2*wl);
X.setTransform(R,0,0,R,0,0);draw(dt,0);raf=requestAnimationFrame(tick);}
function onDone(f){D.on("celebrate",function(){if(!D.state.reducedMotion)f();});D.on("turn-end",function(e){if(e&&e.status==="done"&&!D.state.reducedMotion)f();});}
addEventListener("resize",function(){fit();kick();});
document.addEventListener("visibilitychange",kick);
if(typeof ResizeObserver==="function")new ResizeObserver(function(){if(Math.max(1,innerWidth)!==W||Math.max(1,innerHeight)!==H){fit();kick();}}).observe(document.documentElement);
`;

// Fireworks with gravity and fading trails: launch(n) sends n rockets up from
// the bottom that burst in the sky; fw(dt) draws them (additive). Needs FC,
// an array of CSS colors.
const FIREWORKS = `var FN=420,fx=new Float32Array(FN),fy=new Float32Array(FN),fu=new Float32Array(FN),fv=new Float32Array(FN),fl=new Float32Array(FN),fc=new Uint8Array(FN),fi=0,fon=0,RK=[];
function burst(x,y,c){var n=72,m=Math.min(W,H)*0.24;for(var k=0;k<n;k++){var i=fi;fi=(fi+1)%FN;var a=k/n*6.2832+Math.random()*0.15,s=m*(0.45+0.55*Math.random());fx[i]=x;fy[i]=y;fu[i]=Math.cos(a)*s;fv[i]=Math.sin(a)*s;fl[i]=rnd(1.1,1.9);fc[i]=(k%5===0)?(c+1)%FC.length:c;}fon=2.6;}
function launch(n){for(var k=0;k<n;k++)RK.push({d:k*0.42+Math.random()*0.15,t:0,x:W*(0.18+0.64*((k+0.5)/n))+rnd(-40,40),y:H*rnd(0.12,0.38),c:Math.floor(Math.random()*FC.length)});}
function fw(dt){X.globalCompositeOperation="lighter";X.lineCap="round";
for(var r=RK.length-1;r>=0;r--){var o=RK[r];if(o.d>0){o.d-=dt;continue;}o.t+=dt/0.75;var e=1-Math.pow(1-Math.min(1,o.t),3),yy=H+10+(o.y-H-10)*e;X.globalAlpha=0.8;X.strokeStyle=FC[o.c];X.lineWidth=2;X.beginPath();X.moveTo(o.x,yy);X.lineTo(o.x,yy+26*(1-e)+4);X.stroke();fon=2.6;if(o.t>=1){burst(o.x,o.y,o.c);RK.splice(r,1);}}
if(fon<=0)return;fon-=dt;var dr=Math.pow(0.28,dt),g=H*0.11*dt;X.lineWidth=1.7;
for(var i=0;i<FN;i++){if(fl[i]<=0)continue;fl[i]-=dt;fu[i]*=dr;fv[i]=fv[i]*dr+g;fx[i]+=fu[i]*dt;fy[i]+=fv[i]*dt;var a=Math.min(1,fl[i]*0.85);if(fl[i]<0.5&&Math.random()<0.35)continue;X.globalAlpha=a;X.strokeStyle=FC[fc[i]];X.beginPath();X.moveTo(fx[i],fy[i]);X.lineTo(fx[i]-fu[i]*0.11,fy[i]-fv[i]*0.11);X.stroke();}}
`;

const canvasScene = (code, { style = '', after = '', prelude = '' } = {}) =>
  `<style>${style}</style><canvas id="c"></canvas>${after}<script>${LOOP}${prelude}${code}
fit();kick();</script>`;

// --- Aurora -----------------------------------------------------------------------

const AURORA = canvasScene(`var CL=["60,240,170","70,190,255","150,110,255"],SP=[],WH,NS=0,ST,bg,sh=-1,fl=0;
function mk(c){var s=document.createElement("canvas");s.width=32;s.height=128;var g=s.getContext("2d"),v=g.createLinearGradient(0,0,0,128);v.addColorStop(0,"rgba("+c+",0)");v.addColorStop(0.5,"rgba("+c+",0.2)");v.addColorStop(0.86,"rgba("+c+",1)");v.addColorStop(1,"rgba("+c+",0)");g.fillStyle=v;g.fillRect(0,0,32,128);g.globalCompositeOperation="destination-in";var h=g.createLinearGradient(0,0,32,0);h.addColorStop(0,"rgba(0,0,0,0)");h.addColorStop(0.5,"rgba(0,0,0,1)");h.addColorStop(1,"rgba(0,0,0,0)");g.fillStyle=h;g.fillRect(0,0,32,128);return s;}
for(var i=0;i<3;i++)SP.push(mk(CL[i]));WH=mk("230,255,245");
function onSize(){NS=Math.min(200,Math.round(W*H/8000));ST=new Float32Array(NS*4);for(var i=0;i<NS;i++){var o=i*4;ST[o]=Math.random()*W;ST[o+1]=Math.pow(Math.random(),1.5)*H*0.85;ST[o+2]=Math.random()<0.15?1.6:1;ST[o+3]=Math.random()*6.3;}
bg=X.createLinearGradient(0,0,0,H);bg.addColorStop(0,"#030814");bg.addColorStop(0.55,"#06121f");bg.addColorStop(1,"#08191d");}
function draw(dt){fl+=dt*(1+1.6*wk);
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.fillStyle=bg;X.fillRect(0,0,W,H);X.fillStyle="#dceaff";
for(var i=0;i<NS;i++){var o=i*4;X.globalAlpha=0.18+0.4*(0.5+0.5*Math.sin(T*1.1+ST[o+3]));X.fillRect(ST[o],ST[o+1],ST[o+2],ST[o+2]);}
X.globalCompositeOperation="lighter";
var st=Math.max(4,Math.ceil(W/300)),br=0.6+0.55*wk,s=0,sx=0,t=fl*0.1;
if(sh>=0){sh+=dt;var q=Math.min(1,sh/1.7);s=Math.sin(q*3.1416);sx=-0.15*W+1.3*W*q;if(sh>1.7)sh=-1;}
for(var r=0;r<3;r++){var im=SP[r],p=r*2.3,b0=H*(0.19+0.1*r),am=H*0.08;
for(var x=-st;x<W+st;x+=st){
var y=b0+am*Math.sin(x*0.0017+t*1.2+p)+am*0.45*Math.sin(x*0.0049-t*1.9+p*1.4);
var n=0.5+0.5*Math.sin(x*0.0081+t*2.6+p)*Math.sin(x*0.0029-t*1.1+p*0.6);
var h=H*(0.2+0.26*n)*(0.85+0.15*Math.sin(x*0.023+t*4+p));
var ry=Math.sin(x*0.11+t*1.5+p*3)*Math.sin(x*0.037-t*0.8);X.globalAlpha=Math.min(1,(0.16+0.55*n*n)*(0.45+0.55*ry*ry)*br*(r===2?0.75:1));X.drawImage(im,x-st,y-h,st*2,h*1.15);
if(s>0){var d=(x-sx)/(W*0.1),k=Math.exp(-d*d)*s;if(k>0.02){X.globalAlpha=k*0.26*(0.4+n);X.drawImage(WH,x-st,y-h,st*2,h*1.15);}}}}}
onDone(function(){sh=0;});`);

// --- Neon Horizon -------------------------------------------------------------------

const NEON_HORIZON = canvasScene(
  `var hz=0,cam=0,SUN,sr=0,sky,gnd,gg,hg,MT=[],ph=0,pu=0,NS=0,ST;
function onSize(){hz=Math.round(H*0.62);cam=H-hz;
sky=X.createLinearGradient(0,0,0,hz);sky.addColorStop(0,"#06021a");sky.addColorStop(0.55,"#160632");sky.addColorStop(1,"#360b4a");
gnd=X.createLinearGradient(0,hz,0,H);gnd.addColorStop(0,"#15042a");gnd.addColorStop(1,"#060110");
gg=X.createLinearGradient(0,hz,0,H);gg.addColorStop(0,"rgba(255,70,200,0)");gg.addColorStop(0.2,"rgba(255,70,200,0.2)");gg.addColorStop(1,"rgba(255,100,220,0.5)");
hg=X.createLinearGradient(0,hz-60,0,hz+30);hg.addColorStop(0,"rgba(255,60,170,0)");hg.addColorStop(0.67,"rgba(255,60,170,0.24)");hg.addColorStop(1,"rgba(255,60,170,0)");
sr=Math.max(4,Math.round(Math.min(W,H)*0.17));var z=sr*4,c=sr*2;SUN=document.createElement("canvas");SUN.width=SUN.height=z;var g=SUN.getContext("2d"),q=g.createRadialGradient(c,c,sr*0.7,c,c,c);q.addColorStop(0,"rgba(255,70,150,0.38)");q.addColorStop(1,"rgba(255,70,150,0)");g.fillStyle=q;g.fillRect(0,0,z,z);
g.save();g.beginPath();g.arc(c,c,sr,0,6.2832);g.clip();q=g.createLinearGradient(0,c-sr,0,c+sr);q.addColorStop(0,"#ffd76a");q.addColorStop(0.45,"#ff8a5a");q.addColorStop(1,"#ff2d95");g.fillStyle=q;g.fillRect(c-sr,c-sr,sr*2,sr*2);
g.globalCompositeOperation="destination-out";for(var k=0;k<6;k++)g.fillRect(c-sr,c+sr*(0.04+k*0.16),sr*2,sr*(0.025+k*0.018));g.restore();
MT=[];for(var L=0;L<2;L++){var n=Math.max(12,Math.round(W/55)),pts=new Float32Array((n+1)*2);for(var i=0;i<=n;i++){var x=i/n*W,e=Math.min(1,Math.max(0,(Math.abs(x-W/2)/(W/2)-0.24)/0.5));pts[i*2]=x;pts[i*2+1]=hz-e*e*H*(L?0.1:0.16)*rnd(0.45,1);}MT.push(pts);}
NS=Math.min(90,Math.round(W*H/20000));ST=new Float32Array(NS*3);for(var i=0;i<NS;i++){ST[i*3]=Math.random()*W;ST[i*3+1]=Math.random()*hz*0.8;ST[i*3+2]=Math.random()*6.3;}}
function mtn(p,fill,line){var n=p.length/2,i;X.globalCompositeOperation="source-over";X.beginPath();X.moveTo(0,hz);for(i=0;i<n;i++)X.lineTo(p[i*2],p[i*2+1]);X.lineTo(W,hz);X.closePath();X.globalAlpha=1;X.fillStyle=fill;X.fill();
X.beginPath();for(i=0;i<n;i++){var x=p[i*2],y=p[i*2+1];if(y<hz-2){X.moveTo(x,y);X.lineTo(x,hz);if(i>0){X.moveTo(x,y);X.lineTo(p[i*2-2],hz);}}}
X.globalCompositeOperation="lighter";X.strokeStyle=line;X.lineWidth=1;X.globalAlpha=0.22;X.stroke();
X.beginPath();for(i=0;i<n;i++)X.lineTo(p[i*2],p[i*2+1]);X.globalAlpha=0.7;X.lineWidth=1.4;X.stroke();}
function draw(dt){ph=(ph+dt*(0.45+1.9*wk))%1;if(pu>0)pu=Math.max(0,pu-dt*0.55);
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.fillStyle=sky;X.fillRect(0,0,W,hz);
X.fillStyle="#f3d9ff";for(var i=0;i<NS;i++){X.globalAlpha=0.12+0.25*(0.5+0.5*Math.sin(T*0.9+ST[i*3+2]));X.fillRect(ST[i*3],ST[i*3+1],1.3,1.3);}
var sc=1+0.07*pu*Math.abs(Math.cos(pu*9)),z=SUN.width*sc;X.globalAlpha=Math.min(1,0.6+0.35*pu+0.06*wk);X.drawImage(SUN,W/2-z/2,hz-sr*0.45-z/2,z,z);
mtn(MT[0],"#1b0634","#b05cff");mtn(MT[1],"#11031e","#ff4fc0");
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.fillStyle=gnd;X.fillRect(0,hz,W,cam+1);X.fillStyle=hg;X.fillRect(0,hz-60,W,90);
X.beginPath();for(var j=0;j<28;j++){var y=hz+cam/((j+1-ph)*0.55+0.45);if(y>H+2)continue;X.moveTo(0,y);X.lineTo(W,y);}
var S=W*0.085;for(var k=-24;k<=24;k++){X.moveTo(W/2,hz);X.lineTo(W/2+k*S,H);}
X.globalCompositeOperation="lighter";X.strokeStyle=gg;X.lineWidth=3.5;X.globalAlpha=0.22+0.12*wk;X.stroke();X.lineWidth=1;X.globalAlpha=0.8+0.2*wk;X.stroke();
X.globalAlpha=0.65;X.fillStyle="#ff78dc";X.fillRect(0,hz-0.5,W,1);
fw(dt);}
onDone(function(){pu=1;launch(3);});`,
  { prelude: `var FC=["#ff5fc8","#5ef0ff","#ffd36b","#b48cff"];${FIREWORKS}` }
);

// --- Ember --------------------------------------------------------------------------

const EMBER = canvasScene(`var N=360,ex=new Float32Array(N),ey=new Float32Array(N),eu=new Float32Array(N),ev=new Float32Array(N),el=new Float32Array(N),em=new Float32Array(N),es=new Float32Array(N),ek=new Uint8Array(N),ei=0,ne=0,ac=0,fl=0,pa=0,MX=120,sd=0,SPR,bg,gl;
(function(){SPR=document.createElement("canvas");SPR.width=SPR.height=32;var g=SPR.getContext("2d"),q=g.createRadialGradient(16,16,0,16,16,16);q.addColorStop(0,"rgba(255,245,215,1)");q.addColorStop(0.15,"rgba(255,190,90,0.95)");q.addColorStop(0.4,"rgba(255,120,35,0.4)");q.addColorStop(1,"rgba(255,70,10,0)");g.fillStyle=q;g.fillRect(0,0,32,32);})();
function put(k,x,y,u,v,l,s){var i=ei,t=0;while(ek[i]&&t<N){i=(i+1)%N;t++;}if(ek[i])return -1;ei=(i+1)%N;ex[i]=x;ey[i]=y;eu[i]=u;ev[i]=v;el[i]=em[i]=l;es[i]=s;ek[i]=k;if(k===1)ne++;return i;}
function ember(y,aged){var i=put(1,Math.random()*W,y,rnd(-8,8),-rnd(26,62),H/40*rnd(0.55,1.15),rnd(1.1,3));if(i>=0&&aged)el[i]=em[i]*rnd(0.2,1);}
function onSize(){MX=Math.min(240,Math.round(W*H/5200));bg=X.createLinearGradient(0,0,0,H);bg.addColorStop(0,"#0b0908");bg.addColorStop(0.6,"#120c0a");bg.addColorStop(1,"#1b0f0a");
gl=X.createRadialGradient(W/2,H*1.1,0,W/2,H*1.1,Math.max(W,H)*0.75);gl.addColorStop(0,"rgba(255,105,30,0.42)");gl.addColorStop(0.4,"rgba(200,60,15,0.14)");gl.addColorStop(1,"rgba(120,30,5,0)");
if(!sd){sd=1;for(var i=0;i<MX*0.6;i++)ember(rnd(H*0.1,H),1);}}
D.on("pointer",function(){pa=1;});
D.on("typing",function(){if(!D.state.reducedMotion&&Math.random()<0.5)ember(H+6,0);});
function draw(dt){var m=1+0.8*wk;fl=Math.max(0,fl-dt*0.5);pa=Math.max(0,pa-dt*0.3);
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.fillStyle=bg;X.fillRect(0,0,W,H);
X.globalAlpha=Math.min(1,0.72+0.12*Math.sin(T*0.7)*Math.sin(T*1.9)+0.22*wk+0.6*fl);X.fillStyle=gl;X.fillRect(0,0,W,H);
var cap=MX*(0.6+0.4*wk);ac+=dt*cap/(H/45)*1.4*m;while(ac>=1){ac-=1;if(ne<cap)ember(H+8,0);}
var px=D.state.pointer.x*W,py=D.state.pointer.y*H,RR=170;X.globalCompositeOperation="lighter";X.strokeStyle="#ffbf6a";X.lineWidth=1.4;X.lineCap="round";
for(var i=0;i<N;i++){var k=ek[i];if(!k)continue;el[i]-=dt;if(el[i]<=0||ey[i]<-20||ey[i]>H+40){ek[i]=0;if(k===1)ne--;continue;}
if(k===1){eu[i]+=((Math.sin(ey[i]*0.011+T*0.6+i)*22+Math.sin(ex[i]*0.007-T*0.45)*12)-eu[i])*Math.min(1,dt*0.9);ex[i]+=eu[i]*dt;ey[i]+=ev[i]*m*dt;}
else{ev[i]+=H*0.32*dt;eu[i]*=1-0.6*dt;ex[i]+=eu[i]*dt;ey[i]+=ev[i]*dt;}
if(pa>0){var dx=ex[i]-px,dy=ey[i]-py,d2=dx*dx+dy*dy;if(d2<RR*RR&&d2>1){var d=Math.sqrt(d2),f=(1-d/RR)*pa*90*dt/d;ex[i]+=dx*f;ey[i]+=dy*f;}}
var a,s;if(k===1){a=Math.min(1,(em[i]-el[i])*1.5)*Math.min(1,el[i]/(em[i]*0.4))*(0.65+0.35*Math.sin(T*8+i*1.7))*(0.45+0.55*Math.max(0,ey[i]/H));s=es[i]*4.5*(0.75+0.25*a);X.globalAlpha=Math.min(1,a*0.95);}
else{a=Math.min(1,el[i]);s=es[i]*3.4;X.globalAlpha=a;X.beginPath();X.moveTo(ex[i],ey[i]);X.lineTo(ex[i]-eu[i]*0.045,ey[i]-ev[i]*0.045);X.stroke();}
X.drawImage(SPR,ex[i]-s,ey[i]-s,s*2,s*2);}}
onDone(function(){fl=1;for(var j=0;j<120;j++){var an=-1.5708+rnd(-0.6,0.6),sp=H*rnd(0.4,0.8);put(2,W/2+rnd(-24,24),H+4,Math.cos(an)*sp,Math.sin(an)*sp,rnd(1,2.1),rnd(0.8,1.8));}});`);

// --- Abyss --------------------------------------------------------------------------

const ABYSS = canvasScene(`var MP=240,N=0,qx=new Float32Array(MP),qy=new Float32Array(MP),qu=new Float32Array(MP),qv=new Float32Array(MP),qp=new Float32Array(MP),DOT,RAY,CC,CX,IM,PX,ca=1,bg,J=[],pa=0,rx=0,ry=0,rr=-1,ra=0,sd=0;
function spr(w,h){var s=document.createElement("canvas");s.width=w;s.height=h;return s;}
(function(){DOT=spr(24,24);var g=DOT.getContext("2d"),q=g.createRadialGradient(12,12,0,12,12,12);q.addColorStop(0,"rgba(210,255,245,1)");q.addColorStop(0.2,"rgba(90,255,215,0.8)");q.addColorStop(0.5,"rgba(40,200,190,0.18)");q.addColorStop(1,"rgba(20,150,160,0)");g.fillStyle=q;g.fillRect(0,0,24,24);
RAY=spr(32,128);g=RAY.getContext("2d");q=g.createLinearGradient(0,0,0,128);q.addColorStop(0,"rgba(150,240,255,1)");q.addColorStop(1,"rgba(150,240,255,0)");g.fillStyle=q;g.fillRect(0,0,32,128);g.globalCompositeOperation="destination-in";q=g.createLinearGradient(0,0,32,0);q.addColorStop(0,"rgba(0,0,0,0)");q.addColorStop(0.5,"rgba(0,0,0,1)");q.addColorStop(1,"rgba(0,0,0,0)");g.fillStyle=q;g.fillRect(0,0,32,128);
CC=spr(72,32);CX=CC.getContext("2d");IM=CX.createImageData(72,32);PX=IM.data;for(var i=0;i<PX.length;i+=4){PX[i]=120;PX[i+1]=240;PX[i+2]=225;}})();
function caus(t){var i=3;for(var y=0;y<32;y++){var f=1-y/32;f*=f;for(var x=0;x<72;x++){var u=x*0.17,v=y*0.26,a=Math.sin(u+Math.sin(v*1.4+t*0.5)*1.6+t*0.4)+Math.sin(v*1.2-u*0.5+Math.sin(u*0.8-t*0.35)*1.4-t*0.3),c=1-Math.min(1,Math.abs(a)*0.9);PX[i]=c*c*c*f*255;i+=4;}}CX.putImageData(IM,0,0);}
function jel(o,y){o.x=rnd(0.08,0.92)*W;o.y=y;o.s=rnd(22,42);o.p=Math.random()*6.3;}
function onSize(){N=Math.min(MP,Math.round(W*H/6500));bg=X.createLinearGradient(0,0,0,H);bg.addColorStop(0,"#06232e");bg.addColorStop(0.4,"#03141c");bg.addColorStop(1,"#01080d");
if(!sd){sd=1;for(var i=0;i<MP;i++){qx[i]=Math.random()*W;qy[i]=Math.random()*H;qp[i]=Math.random();}for(var k=0;k<3;k++){J.push({});jel(J[k],rnd(0.25,1)*H);}}}
D.on("pointer",function(){pa=1;});
function jelly(o,dt){var p=Math.sin(T*1.5+o.p);o.y-=(5+9*Math.max(0,p))*dt*(o.s/32);o.x+=Math.sin(T*0.17+o.p)*5*dt;if(o.y<-o.s*4)jel(o,H+o.s*2);
var x=o.x,y=o.y,bw=o.s*(1+0.07*p),bh=o.s*0.75*(1-0.09*p);X.beginPath();X.ellipse(x,y,bw,bh,0,3.1416,6.2832);X.moveTo(x-bw*0.6,y);X.ellipse(x,y,bw*0.6,bh*0.6,0,3.1416,6.2832);X.moveTo(x-bw,y);X.quadraticCurveTo(x,y+bh*0.25,x+bw,y);
for(var k=0;k<5;k++){var tx=x+(k-2)*bw*0.32;X.moveTo(tx,y+bh*0.1);for(var s=1;s<7;s++)X.lineTo(tx+Math.sin(T*1.6+k*1.1-s*0.8+o.p)*o.s*0.05*s,y+bh*0.1+s*o.s*0.36);}
X.strokeStyle="rgb(185,150,255)";X.lineWidth=6;X.globalAlpha=0.07;X.stroke();X.lineWidth=1.3;X.globalAlpha=0.38;X.stroke();}
function draw(dt,still){pa=Math.max(0,pa-dt*0.25);
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.fillStyle=bg;X.fillRect(0,0,W,H);X.globalCompositeOperation="lighter";
for(var k=0;k<5;k++){var x=W*(0.1+0.2*k)+Math.sin(T*0.07+k*1.7)*W*0.05,w=W*0.07*(1+0.4*Math.sin(k*2.1));X.save();X.translate(x,-10);X.rotate(0.15*Math.sin(T*0.05+k)+(x/W-0.5)*0.3);X.globalAlpha=0.04+0.02*Math.sin(T*0.3+k*1.3);X.drawImage(RAY,-w/2,0,w,H*0.85);X.restore();}
ca+=dt;if(ca>0.05||still){ca=0;caus(T);}X.globalAlpha=0.2+0.08*wk;X.drawImage(CC,0,0,W,H*0.42);
X.lineCap="round";X.lineJoin="round";for(var j=0;j<J.length;j++)jelly(J[j],dt);
if(rr>=0){var M=Math.max(W,H);rr+=dt*M*0.42;ra=Math.max(0,1-rr/(M*0.95));if(ra<=0)rr=-1;else{X.strokeStyle="rgb(150,255,230)";X.beginPath();X.arc(rx,ry,rr,0,6.2832);X.lineWidth=16;X.globalAlpha=0.06*ra;X.stroke();X.lineWidth=1.6;X.globalAlpha=0.4*ra;X.stroke();X.beginPath();X.arc(rx,ry,rr*0.7,0,6.2832);X.globalAlpha=0.18*ra;X.stroke();}}
var px=D.state.pointer.x*W,py=D.state.pointer.y*H,pr=Math.max(W,H)*0.25;
for(var i=0;i<N;i++){var x=qx[i],y=qy[i],u=qu[i],v=qv[i],ph=qp[i];
u+=Math.sin(T*0.31+ph*7+y*0.006)*9*dt;v+=Math.cos(T*0.27+ph*5+x*0.006)*9*dt-1.5*dt;
if(pa>0){var dx=px-x,dy=py-y,d=Math.sqrt(dx*dx+dy*dy)+0.1;if(d<pr){var f=pa*(1-d/pr)*55*dt/d;u+=(dx-dy*0.8)*f;v+=(dy+dx*0.8)*f;}}
u*=1-0.7*dt;v*=1-0.7*dt;x+=u*dt;y+=v*dt;if(x<-12)x=W+12;else if(x>W+12)x=-12;if(y<-12)y=H+12;else if(y>H+12)y=-12;qx[i]=x;qy[i]=y;qu[i]=u;qv[i]=v;
var a=(0.28+0.4*(0.5+0.5*Math.sin(T*0.9+ph*6.3)))*(1+wk*(0.7+0.6*Math.sin(T*4.2+ph*6.3)));
if(rr>=0){var ex=x-rx,ey=y-ry,e=(Math.sqrt(ex*ex+ey*ey)-rr)/50;a+=Math.exp(-e*e)*ra*1.3;}
var s=4+ph*5;X.globalAlpha=Math.min(1,a);X.drawImage(DOT,x-s,y-s,s*2,s*2);}}
onDone(function(){rx=W*rnd(0.2,0.8);ry=H*rnd(0.25,0.75);rr=0;ra=1;});`);

// --- Phosphor -----------------------------------------------------------------------

const PHOSPHOR = canvasScene(
  `var G="0123456789ABCDEF:;.=+*<>/|#%",cw=16,rh=18,cols=0,hy,sp,wt,ac=0;
function reset(i,init){hy[i]=init?Math.floor(rnd(-30,H/rh)):-1;sp[i]=rnd(0.35,1);wt[i]=init?(Math.random()<0.4?0:rnd(0,40)):rnd(4,60);}
function onSize(){cw=W<900?14:16;rh=cw+3;cols=Math.ceil(W/cw);hy=new Float32Array(cols);sp=new Float32Array(cols);wt=new Float32Array(cols);for(var i=0;i<cols;i++)reset(i,1);
X.globalAlpha=1;X.fillStyle="#020904";X.fillRect(0,0,W,H);X.font=(cw-3)+"px ui-monospace,Menlo,Consolas,monospace";X.textBaseline="top";}
function gl(){return G.charAt(Math.floor(Math.random()*G.length));}
function step(){X.globalAlpha=0.14;X.fillStyle="#020904";X.fillRect(0,0,W,H);
for(var i=0;i<cols;i++){if(wt[i]>0){wt[i]-=1;if(wt[i]<=0)hy[i]=-1;continue;}if(Math.random()>sp[i])continue;hy[i]+=1;var y=hy[i]*rh;if(y>H){reset(i,0);continue;}
X.globalAlpha=0.45+0.3*wk;X.fillStyle="#9dffb4";X.fillText(gl(),i*cw+2,y);if(Math.random()<0.25){X.globalAlpha=0.22;X.fillStyle="#3fdc6c";X.fillText(gl(),i*cw+2,y-rh*Math.floor(rnd(2,9)));}}}
function draw(dt,still){if(still){X.globalAlpha=1;X.fillStyle="#020904";X.fillRect(0,0,W,H);X.fillStyle="#5fe485";for(var i=0;i<cols;i++){if(Math.random()<0.55)continue;var h=Math.floor(rnd(0,H/rh)),n=Math.floor(rnd(3,14));for(var j=0;j<n;j++){X.globalAlpha=0.3*(1-j/n);X.fillText(gl(),i*cw+2,(h-j)*rh);}}return;}
ac+=dt*(9+11*wk);var k=0;while(ac>=1&&k<4){ac-=1;k++;step();}if(ac>1)ac=0;}
D.on("typing",function(){if(!cols)return;var i=Math.floor(Math.random()*cols);if(wt[i]>0)wt[i]=0.5;});`,
  {
    style:
      'body{background:#020904}#v{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 45%,rgba(40,255,110,0.04) 0%,rgba(0,0,0,0) 45%,rgba(0,0,0,0.62) 100%)}',
    after: '<div id="v"></div>',
  }
);

const PHOSPHOR_OVERLAY = `<style>
#s{position:fixed;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,0.055) 0px,rgba(0,0,0,0.055) 1px,rgba(0,0,0,0) 1px,rgba(0,0,0,0) 3px)}
#f{position:fixed;inset:0;background:rgba(140,255,170,0.016);opacity:0;animation:fl 5s steps(1,end) infinite}
@keyframes fl{0%{opacity:0}31%{opacity:1}32%{opacity:0.4}33%{opacity:0}71%{opacity:0.7}72%{opacity:0}100%{opacity:0}}
#w{position:fixed;left:0;right:0;top:0;height:150px;opacity:0;transform:translateY(-160px);background:linear-gradient(180deg,rgba(120,255,160,0) 0%,rgba(120,255,160,0.05) 80%,rgba(190,255,205,0.3) 98.5%,rgba(120,255,160,0) 100%)}
#w.go{animation:sw 0.95s cubic-bezier(.45,.05,.55,.95) forwards}
@keyframes sw{0%{opacity:1;transform:translateY(-160px)}88%{opacity:1}100%{opacity:0;transform:translateY(100vh)}}
.rm #f{animation:none}
@media (prefers-reduced-motion:reduce){#f{animation:none}}
</style>
<div id="s"></div><div id="f"></div><div id="w"></div>
<script>
var D=window.durango,w=document.getElementById("w"),de=document.documentElement;
function sweep(){if(D.state.reducedMotion)return;w.classList.remove("go");void w.offsetWidth;w.classList.add("go");}
D.on("celebrate",sweep);D.on("turn-end",function(e){if(e&&e.status==="done")sweep();});
function rm(){de.classList.toggle("rm",!!D.state.reducedMotion);}rm();setInterval(rm,1000);
</script>`;

// --- Starfield ----------------------------------------------------------------------

const STARFIELD = canvasScene(
  `var MX=300,N=0,sx=new Float32Array(MX),sy=new Float32Array(MX),sz=new Float32Array(MX),sk=new Uint8Array(MX),SC=["#e9efff","#bcd4ff","#ffe2bd"],BG,sd=0,ox=0,oy=0;
function star(i,z){sx[i]=rnd(-1.6,1.6);sy[i]=rnd(-1.1,1.1);sz[i]=z;sk[i]=Math.random()<0.7?0:(Math.random()<0.6?1:2);}
function onSize(){N=Math.min(MX,Math.round(W*H/4200));if(!sd){sd=1;for(var i=0;i<MX;i++)star(i,rnd(0.05,1));}
BG=document.createElement("canvas");var w=BG.width=Math.max(1,Math.round(W/2)),h=BG.height=Math.max(1,Math.round(H/2)),g=BG.getContext("2d"),q=g.createLinearGradient(0,0,0,h);q.addColorStop(0,"#03040c");q.addColorStop(0.6,"#060819");q.addColorStop(1,"#0a0a21");g.fillStyle=q;g.fillRect(0,0,w,h);
q=g.createRadialGradient(w*0.78,h*0.28,0,w*0.78,h*0.28,w*0.5);q.addColorStop(0,"rgba(110,60,200,0.13)");q.addColorStop(1,"rgba(110,60,200,0)");g.fillStyle=q;g.fillRect(0,0,w,h);
q=g.createRadialGradient(w*0.18,h*0.78,0,w*0.18,h*0.78,w*0.45);q.addColorStop(0,"rgba(30,120,170,0.09)");q.addColorStop(1,"rgba(30,120,170,0)");g.fillStyle=q;g.fillRect(0,0,w,h);}
function draw(dt){var v=0.018+0.5*wk,f=Math.max(W,H)*0.28,cx=W/2,cy=H*0.46,tl=0.0004+wk*0.05,p=D.state.pointer,k=Math.min(1,dt*2);ox+=((0.5-p.x)*36-ox)*k;oy+=((0.5-p.y)*24-oy)*k;
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.drawImage(BG,0,0,W,H);X.lineCap="round";X.globalCompositeOperation="lighter";
for(var i=0;i<N;i++){var z=sz[i]-v*dt;if(z<0.03){star(i,1);z=1;}sz[i]=z;var b=Math.min(1,0.3+(1-z)*1.1),x=cx+sx[i]/z*f+ox*b,y=cy+sy[i]/z*f+oy*b;
if(x<-60||x>W+60||y<-60||y>H+60){star(i,rnd(0.7,1));continue;}
var z2=z+tl,x2=cx+sx[i]/z2*f+ox*b,y2=cy+sy[i]/z2*f+oy*b,w=(0.7+b*b*1.9)*(1-0.3*wk),dx=x-x2,dy=y-y2;
X.globalAlpha=b*(0.75-0.2*wk)*(0.8+0.2*Math.sin(T*2+i));
if(dx*dx+dy*dy<2.2){X.fillStyle=SC[sk[i]];X.fillRect(x-w/2,y-w/2,w,w);}else{X.strokeStyle=SC[sk[i]];X.lineWidth=w;X.beginPath();X.moveTo(x2,y2);X.lineTo(x,y);X.stroke();}}
fw(dt);}
onDone(function(){launch(2+Math.floor(Math.random()*3));});`,
  { prelude: `var FC=["#ffd166","#5ee7ff","#ff6bd6","#7dffa8"];${FIREWORKS}` }
);

// Offscreen canvas at device resolution, drawn in CSS px: mk(w, h).g is its
// context, .w/.h its CSS size.
const OFFSCREEN = `function mk(w,h){var c=document.createElement("canvas");c.width=Math.max(1,Math.ceil(w*R));c.height=Math.max(1,Math.ceil(h*R));c.g=c.getContext("2d");c.g.scale(R,R);c.w=w;c.h=h;return c;}
`;

// --- Imperium -----------------------------------------------------------------------

const IMPERIUM = canvasScene(
  `MF=30;
var gy=0,S=24,BG,LIT,LX=0,LY=0,SH,cw=1,ch=1,NF=8,BAN,EAG,BB,GLW,FLM,EMB,LEAF,ls=8,NT=0,TX=new Float32Array(8),TY=new Float32Array(8),G=[],spT=2,runT=0,sd=0,
EN=90,qx=new Float32Array(EN),qy=new Float32Array(EN),qu=new Float32Array(EN),qv=new Float32Array(EN),ql=new Float32Array(EN),qi=0,eac=0,
LN=140,lx=new Float32Array(LN),ly=new Float32Array(LN),lu=new Float32Array(LN),lv=new Float32Array(LN),lc=new Uint8Array(LN),lon=new Uint8Array(LN),lan=0,
BXF=[0.05,0.17,0.83,0.95],tri=-1,fr=0,NB=4,bx=new Float32Array(NB),by=new Float32Array(NB),bv=new Float32Array(NB);
for(var i=0;i<4;i++)G.push({on:0,dir:1,x:0,sp:0,run:0,cols:4,rows:2,lane:0,std:0,od:0});
function sol(g,f,run){var p=f/NF*6.2832,b=-Math.abs(Math.sin(p))*0.035*S,am=run?0.26:0.17;g.lineCap="round";
g.strokeStyle="#2a1810";g.lineWidth=S*0.085;for(var k=0;k<2;k++){var q=k?-1:1,fx=Math.sin(p)*am*S*q,lift=Math.max(0,Math.cos(p)*q)*0.06*S;g.beginPath();g.moveTo(0,-0.46*S+b);g.lineTo(fx*0.5,-0.23*S+b-lift*0.5);g.lineTo(fx,-lift);g.stroke();}
g.fillStyle="#7a2219";g.beginPath();g.moveTo(-0.15*S,-0.37*S+b);g.lineTo(0.15*S,-0.37*S+b);g.lineTo(0.11*S,-0.52*S+b);g.lineTo(-0.11*S,-0.52*S+b);g.fill();
g.fillStyle="#6b5a46";g.fillRect(-0.11*S,-0.83*S+b,0.22*S,0.34*S);g.fillStyle="#8c785c";g.fillRect(-0.11*S,-0.83*S+b,0.22*S,0.05*S);
g.strokeStyle="#9c8660";g.lineWidth=S*0.03;g.beginPath();g.moveTo(-0.08*S,-0.15*S+b);g.lineTo(-0.02*S,-1.42*S+b);g.stroke();g.fillStyle="#d9d2c2";g.beginPath();g.moveTo(-0.035*S,-1.38*S+b);g.lineTo(-0.005*S,-1.38*S+b);g.lineTo(-0.018*S,-1.52*S+b);g.fill();
g.strokeStyle="#3d2a1e";g.lineWidth=S*0.06;g.beginPath();g.moveTo(-0.04*S,-0.78*S+b);g.lineTo(-0.07*S,-0.55*S+b);g.stroke();
g.fillStyle="#3d2a1e";g.beginPath();g.arc(0.02*S,-0.92*S+b,0.075*S,0,6.2832);g.fill();g.fillStyle="#a88a52";g.beginPath();g.arc(0.02*S,-0.94*S+b,0.08*S,3.1416,6.2832);g.fill();
g.strokeStyle="#b8281e";g.lineWidth=S*0.055;g.beginPath();g.moveTo(-0.08*S,-1.0*S+b);g.quadraticCurveTo(0.02*S,-1.12*S+b,0.12*S,-1.0*S+b);g.stroke();
g.fillStyle="#8a1d1a";g.strokeStyle="#c9a24a";g.lineWidth=S*0.028;g.beginPath();var x0=0.06*S,y0=-0.87*S+b,w=0.2*S,h=0.54*S,r=0.05*S;g.moveTo(x0+r,y0);g.lineTo(x0+w-r,y0);g.quadraticCurveTo(x0+w,y0,x0+w,y0+r);g.lineTo(x0+w,y0+h-r);g.quadraticCurveTo(x0+w,y0+h,x0+w-r,y0+h);g.lineTo(x0+r,y0+h);g.quadraticCurveTo(x0,y0+h,x0,y0+h-r);g.lineTo(x0,y0+r);g.quadraticCurveTo(x0,y0,x0+r,y0);g.fill();g.stroke();
g.fillStyle="#d8b55e";g.beginPath();g.arc(x0+w/2,y0+h/2,0.035*S,0,6.2832);g.fill();}
function rad(c,s,a,b){var g=c.g,q=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);q.addColorStop(0,a);q.addColorStop(0.4,b);q.addColorStop(1,"rgba(0,0,0,0)");g.fillStyle=q;g.fillRect(0,0,s,s);return c;}
function cloth(c,w,h,txt){var g=c.g;g.fillStyle="#8e1b1b";g.fillRect(0,0,w,h*0.88);g.strokeStyle="#d4ae55";g.lineWidth=Math.max(1,w*0.06);g.strokeRect(w*0.06,w*0.06,w*0.88,h*0.88-w*0.12);g.fillStyle="#d4ae55";for(var k=0;k<6;k++)g.fillRect(w*(k+0.25)/6,h*0.88,w*0.08,h*0.1);
g.font="bold "+Math.max(5,w*0.26)+"px Georgia,'Times New Roman',serif";g.textAlign="center";g.textBaseline="middle";g.fillText(txt,w/2,h*0.5);if(h>w*1.3){g.lineWidth=Math.max(1,w*0.05);g.beginPath();g.arc(w/2,h*0.5,w*0.3,0,6.2832);g.stroke();}}
function onSize(){gy=Math.round(H*0.8);S=Math.max(20,Math.min(46,H*0.042));
BG=mk(W,H);var g=BG.g,sk=g.createLinearGradient(0,0,0,gy);sk.addColorStop(0,"#0b0810");sk.addColorStop(0.45,"#170e15");sk.addColorStop(0.72,"#2e1718");sk.addColorStop(0.9,"#5a2c1c");sk.addColorStop(1,"#7a3c20");g.fillStyle=sk;g.fillRect(0,0,W,gy);
for(var i=0;i<80;i++){g.globalAlpha=rnd(0.15,0.5);g.fillStyle="#f4e6d0";var z=Math.random()<0.2?1.5:1;g.fillRect(Math.random()*W,Math.pow(Math.random(),1.4)*H*0.42,z,z);}g.globalAlpha=1;
var hg=g.createRadialGradient(W/2,gy,0,W/2,gy,W*0.5);hg.addColorStop(0,"rgba(255,140,60,0.16)");hg.addColorStop(1,"rgba(255,140,60,0)");g.fillStyle=hg;g.fillRect(0,gy-W*0.5,W,W*0.5);
g.fillStyle="#24130f";g.beginPath();g.moveTo(0,gy);for(var x=0;x<=W;x+=W/40)g.lineTo(x,gy-H*(0.035+0.02*Math.sin(x*0.004)+0.012*Math.sin(x*0.013+1)));g.lineTo(W,gy);g.fill();
var cx=W/2,CH=Math.min(H*0.21,W*0.15),Rx=Math.min(W*0.37,CH*3.3),xl=cx-Rx,xr=cx+Rx,top=gy-CH;
var ah=CH*0.72,aw=ah*0.95,ax=Math.min(W*0.1,xl-aw*0.1),ay=gy-H*0.012;g.fillStyle="#2a1612";g.fillRect(ax-aw/2,ay-ah,aw,ah);g.fillRect(ax-aw*0.55,ay-ah,aw*1.1,ah*0.08);g.fillStyle=sk;g.beginPath();g.moveTo(ax-aw*0.17,ay);g.lineTo(ax-aw*0.17,ay-ah*0.42);g.arc(ax,ay-ah*0.42,aw*0.17,3.1416,6.2832);g.lineTo(ax+aw*0.17,ay);g.fill();
for(var k=-1;k<=1;k+=2){g.beginPath();var sx=ax+k*aw*0.36;g.moveTo(sx-aw*0.07,ay);g.lineTo(sx-aw*0.07,ay-ah*0.3);g.arc(sx,ay-ah*0.3,aw*0.07,3.1416,6.2832);g.lineTo(sx+aw*0.07,ay);g.fill();}
g.fillStyle="#2a1612";var c0=Math.max(xr+CH*0.2,W*0.86),cs=CH*0.16;for(var k=0;k<6;k++){var px=c0+k*cs,hh=CH*(0.55+0.3*Math.sin(k*2.3+1)*(k%2));if(px>W+cs)break;g.fillRect(px-cs*0.16,gy-hh,cs*0.32,hh);g.fillRect(px-cs*0.24,gy-hh,cs*0.48,cs*0.12);}if(c0<W)g.fillRect(c0-cs*0.3,gy-CH*0.62,cs*2.6,cs*0.16);
var NP=48,PF=new Float32Array(NP+1);for(var k=0;k<=NP;k++){var u=k/NP*2-1;PF[k]=u<0.5?top:top+CH*(0.12+(u-0.5)*0.95)+Math.sin(u*47)*CH*0.025;}
function prof(x){var k=Math.round((x-xl)/(2*Rx)*NP);return PF[Math.max(0,Math.min(NP,k))];}
var bg=g.createLinearGradient(0,top,0,gy);bg.addColorStop(0,"#6e3d26");bg.addColorStop(0.15,"#4a2a1d");bg.addColorStop(1,"#22130e");g.fillStyle=bg;g.beginPath();g.moveTo(xl,gy);for(var k=0;k<=NP;k++)g.lineTo(xl+k/NP*2*Rx,PF[k]);g.lineTo(xr,gy);g.fill();
LX=xl-2;LY=top-2;LIT=mk(2*Rx+4,CH+4);var lg=LIT.g;lg.translate(-LX,-LY);var wg=lg.createLinearGradient(0,top,0,gy);wg.addColorStop(0,"rgba(255,170,80,0.55)");wg.addColorStop(1,"rgba(220,90,30,0.35)");lg.fillStyle=wg;
var TH=[0.26,0.24,0.22],NC=26,s13=Math.sin(1.3),yb=gy;NT=0;g.fillStyle="#0d0705";
for(var t=0;t<4;t++){var th=t<3?TH[t]*CH:CH*0.28,yt=yb-th;g.strokeStyle="rgba(140,80,50,0.45)";g.lineWidth=1;
for(var j=0;j<NC;j++){var xa=cx+Rx*Math.sin(-1.3+2.6*j/NC)/s13,xb=cx+Rx*Math.sin(-1.3+2.6*(j+1)/NC)/s13,bw=xb-xa,mid=(xa+xb)/2;if(prof(mid)>yt+1)continue;
g.beginPath();g.moveTo(xa,yb);g.lineTo(xa,yt);g.stroke();
if(t<3){var pr=bw*0.24,o0=xa+pr/2,o1=xb-pr/2,ra=(o1-o0)/2,yo=yt+th*0.16;g.beginPath();g.moveTo(o0,yb-th*0.06);g.lineTo(o0,yo+ra);g.arc(mid,yo+ra,ra,3.1416,6.2832);g.lineTo(o1,yb-th*0.06);g.fill();
if(t<2&&Math.random()<0.4){lg.beginPath();lg.moveTo(o0,yb-th*0.06);lg.lineTo(o0,yo+ra);lg.arc(mid,yo+ra,ra,3.1416,6.2832);lg.lineTo(o1,yb-th*0.06);lg.fill();}
if(t===0&&j%6===3&&NT<4){TX[NT]=xa;TY[NT]=yb-th*0.55;NT++;}}else if(j%2===0)g.fillRect(mid-bw*0.15,yt+th*0.3,bw*0.3,th*0.3);}
g.strokeStyle="#7a4429";g.lineWidth=Math.max(1,CH*0.014);g.beginPath();for(var x=xl;x<=xr;x+=2){var e=prof(x)<=yt+1;if(e){g.moveTo(x,yt);g.lineTo(Math.min(xr,x+2),yt);}}g.stroke();yb=yt;}
var eg=g.createLinearGradient(xl,0,xr,0);eg.addColorStop(0,"rgba(10,5,4,0.6)");eg.addColorStop(0.2,"rgba(10,5,4,0)");eg.addColorStop(0.8,"rgba(10,5,4,0)");eg.addColorStop(1,"rgba(10,5,4,0.6)");g.fillStyle=eg;g.beginPath();g.moveTo(xl,gy);for(var k=0;k<=NP;k++)g.lineTo(xl+k/NP*2*Rx,PF[k]);g.lineTo(xr,gy);g.fill();
var gg=g.createLinearGradient(0,gy,0,H);gg.addColorStop(0,"#2a1810");gg.addColorStop(1,"#0e0806");g.fillStyle=gg;g.fillRect(0,gy,W,H-gy);g.fillStyle="rgba(170,110,60,0.25)";g.fillRect(0,gy,W,1);
for(var k=0;k<2;k++){var bxp=k?W*0.94:W*0.06;TX[NT]=bxp;TY[NT]=gy+S*0.05-S*0.95;NT++;g.strokeStyle="#1a0f0a";g.lineWidth=Math.max(1.5,S*0.06);g.beginPath();g.moveTo(bxp-S*0.25,gy+S*0.12);g.lineTo(bxp,gy-S*0.8);g.lineTo(bxp+S*0.25,gy+S*0.12);g.moveTo(bxp,gy+S*0.12);g.lineTo(bxp,gy-S*0.8);g.stroke();g.fillStyle="#3a2414";g.fillRect(bxp-S*0.2,gy-S*0.9,S*0.4,S*0.12);}
cw=Math.ceil(S*0.9);ch=Math.ceil(S*1.6);SH=mk(cw*NF*2,ch);for(var d=0;d<2;d++)for(var f=0;f<NF;f++){var sg=SH.g;sg.save();sg.translate((d*NF+f)*cw+cw/2,ch-1);if(d)sg.scale(-1,1);sol(sg,f,0);sg.restore();}
BAN=mk(S*0.62,S*0.78);cloth(BAN,S*0.62,S*0.78,"SPQR");BB=mk(S*1.5,S*2.4);cloth(BB,S*1.5,S*2.4,"SPQR");
EAG=mk(S*0.6,S*0.6);g=EAG.g;var e=S*0.3;g.strokeStyle=g.fillStyle="#d8b04c";g.lineWidth=Math.max(1,S*0.04);g.beginPath();g.moveTo(e-S*0.27,e-S*0.2);g.quadraticCurveTo(e-S*0.12,e-S*0.02,e,e);g.quadraticCurveTo(e+S*0.12,e-S*0.02,e+S*0.27,e-S*0.2);g.stroke();g.beginPath();g.arc(e,e-S*0.02,S*0.045,0,6.2832);g.fill();g.beginPath();g.arc(e,e+S*0.14,S*0.1,0,6.2832);g.stroke();
GLW=rad(mk(64,64),64,"rgba(255,180,90,0.6)","rgba(255,110,40,0.16)");FLM=rad(mk(24,24),24,"rgba(255,245,200,1)","rgba(255,160,50,0.7)");EMB=rad(mk(10,10),10,"rgba(255,220,140,1)","rgba(255,130,40,0.5)");
ls=Math.max(6,Math.round(S*0.32));LEAF=mk(ls*24,ls);var CL=["#e3bd5e","#86a24c","#c23a2c"];for(var c=0;c<3;c++)for(var k=0;k<8;k++){var lg2=LEAF.g;lg2.save();lg2.translate((c*8+k)*ls+ls/2,ls/2);lg2.rotate(k*0.3927);lg2.fillStyle=CL[c];lg2.beginPath();lg2.ellipse(0,0,ls*0.44,ls*0.17,0,0,6.2832);lg2.fill();lg2.restore();}
if(!sd){sd=1;spawn(0,1,W*0.42);spawn(0,-1,W*0.68);for(var i=0;i<NB;i++){bx[i]=Math.random()*W;by[i]=rnd(0.6,0.7);bv[i]=rnd(14,24)*(Math.random()<0.5?-1:1);}}}
function spawn(run,dir,x0){var o=null;for(var i=0;i<4;i++)if(!G[i].on){o=G[i];break;}if(!o)return;dir=dir||(Math.random()<0.5?1:-1);var lane=run?2:(dir>0?0:1);
for(var i=0;i<4;i++){var q=G[i];if(q.on&&q.lane===lane&&x0===undefined){var tail=q.x-q.dir*q.cols*S*0.62;if(q.dir===dir&&(dir>0?tail<W*0.3:tail>W*0.7))return;if(q.dir!==dir)return;}}
o.on=1;o.dir=dir;o.run=run;o.lane=lane;o.rows=run?1:2;o.cols=run?5+Math.floor(Math.random()*3):3+Math.floor(Math.random()*4);o.sp=run?S*3.2:S*0.95;o.std=run?-1:Math.floor(Math.random()*2);o.od=0;o.x=x0!==undefined?x0:(dir>0?-S:W+S);}
function draw(dt){var m=1+0.75*wk,i;fr=Math.max(0,fr-dt*0.35);
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.drawImage(BG,0,0,W,H);
X.globalAlpha=Math.min(1,0.72+0.16*Math.sin(T*7.3)*Math.sin(T*3.1+1)+0.08*Math.sin(T*13)+0.45*fr);X.drawImage(LIT,LX,LY,LIT.w,LIT.h);
X.globalAlpha=0.75;X.strokeStyle="#120a0a";X.lineWidth=1.3;X.beginPath();for(i=0;i<NB;i++){bx[i]+=bv[i]*dt;if(bx[i]<-30)bx[i]=W+30;else if(bx[i]>W+30)bx[i]=-30;var y=by[i]*H+Math.sin(T*0.5+i*2)*6,f=Math.sin(T*7+i*1.7)*S*0.09,w=S*0.17;X.moveTo(bx[i]-w,y-f);X.quadraticCurveTo(bx[i]-w*0.4,y-f*0.2-2,bx[i],y);X.quadraticCurveTo(bx[i]+w*0.4,y-f*0.2-2,bx[i]+w,y-f);}X.stroke();
X.globalCompositeOperation="lighter";
for(i=0;i<NT;i++){var f=0.75+0.25*Math.sin(T*9+i*2.1)*Math.sin(T*5.3+i),r=S*(1.25+0.2*f)*(1+fr*0.7);X.globalAlpha=Math.min(1,0.5*f*(1+fr*0.8));X.drawImage(GLW,TX[i]-r,TY[i]-r,r*2,r*2);var fh=S*0.34*(0.85+0.3*f)*(1+fr*0.6);X.globalAlpha=0.9;X.drawImage(FLM,TX[i]-fh*0.3,TY[i]-fh*0.85,fh*0.6,fh);}
eac+=dt*NT*1.6*(1+3*fr);while(eac>=1&&NT){eac-=1;var t=Math.floor(Math.random()*NT);qx[qi]=TX[t]+rnd(-3,3);qy[qi]=TY[t]-S*0.3;qu[qi]=rnd(-6,6);qv[qi]=-rnd(14,34)*(1+fr);ql[qi]=rnd(1.6,3.4);qi=(qi+1)%EN;}
for(i=0;i<EN;i++){if(ql[i]<=0)continue;ql[i]-=dt;qu[i]+=Math.sin(T*1.7+i)*12*dt;qx[i]+=qu[i]*dt;qy[i]+=qv[i]*dt;X.globalAlpha=Math.min(1,ql[i]*0.5);X.drawImage(EMB,qx[i]-2.5,qy[i]-2.5,5,5);}
X.globalCompositeOperation="source-over";X.globalAlpha=1;
spT-=dt;runT-=dt;var act=0;for(i=0;i<4;i++)if(G[i].on&&!G[i].run)act++;if(spT<=0){if(act<(wk>0.5?3:2))spawn(0);spT=rnd(5,10)*(1-0.45*wk);}if(wk>0.6&&runT<=0){spawn(1);runT=rnd(9,15);}
for(var L=0;L<3;L++)for(i=0;i<4;i++){var o=G[i];if(!o.on||o.lane!==L)continue;var v=o.sp*(o.run?1:m);o.x+=o.dir*v*dt;o.od+=v*dt;
var sc=L===0?0.86:L===1?1:1.06,spc=S*0.62*sc,len=o.cols*spc+S;if((o.dir>0&&o.x-len>W+S)||(o.dir<0&&o.x+len<-S)){o.on=0;continue;}
var f=Math.floor(o.od/(o.run?S*1.15:S*0.62)*NF)%NF,src=(f+(o.dir<0?NF:0))*cw*R;
for(var r=0;r<o.rows;r++){var fy=gy+H*(L===0?0.028:L===1?0.064:0.098)+r*H*0.018,s2=sc*(1+r*0.05),off=r*spc*0.45;
if(r===0&&o.std>=0){var px=o.x-o.dir*S*0.08*s2,pt=fy-S*2.05*s2;X.strokeStyle="#5e4a30";X.lineWidth=Math.max(1,S*0.04);X.beginPath();X.moveTo(px,fy-S*0.45*s2);X.lineTo(px,pt);X.stroke();
if(o.std===0){var bw=BAN.w,bh=BAN.h,b0=px-bw/2;X.beginPath();X.moveTo(b0-2,pt+S*0.08);X.lineTo(b0+bw+2,pt+S*0.08);X.stroke();for(var k=0;k<5;k++)X.drawImage(BAN,k*bw/5*R,0,bw/5*R,bh*R,b0+k*bw/5,pt+S*0.09+Math.sin(T*4.5-k*0.9+o.x*0.02)*S*0.035*k/4,bw/5+0.5,bh);}
else X.drawImage(EAG,px-EAG.w/2,pt-EAG.h*0.75,EAG.w,EAG.h);}
for(var c=0;c<o.cols;c++){var x=o.x-o.dir*(c*spc+off);if(x<-S||x>W+S)continue;X.drawImage(SH,src,0,cw*R,ch*R,x-cw*s2/2,fy-ch*s2,cw*s2,ch*s2);}}}
if(tri>=0){tri+=dt;var up=tri<1.3?1-Math.pow(1-tri/1.3,3):tri<5.2?1:Math.max(0,1-(tri-5.2)/1.2);if(tri>6.5)tri=-1;var bw=BB.w,bh=BB.h,tp=gy-S*3.2;
for(var k=0;k<4;k++){var px=BXF[k]*W,pt=H+bh+10-(H+bh+10-tp)*up;X.strokeStyle="#6b5534";X.lineWidth=Math.max(1.5,S*0.06);X.beginPath();X.moveTo(px,H+4);X.lineTo(px,pt-S*0.1);X.moveTo(px-bw*0.6,pt);X.lineTo(px+bw*0.6,pt);X.stroke();X.drawImage(EAG,px-EAG.w/2,pt-EAG.h*0.9,EAG.w,EAG.h);
for(var j=0;j<6;j++)X.drawImage(BB,j*bw/6*R,0,bw/6*R,bh*R,px-bw/2+j*bw/6,pt+2+Math.sin(T*3.5-j*0.8+k)*S*0.06*j/5,bw/6+0.5,bh);}}
if(lan>0){lan=0;X.globalAlpha=0.85;for(i=0;i<LN;i++){if(!lon[i])continue;lan=1;lx[i]+=(lu[i]+Math.sin(T*2.1+i)*22)*dt;ly[i]+=lv[i]*dt;if(ly[i]>H+ls){lon[i]=0;continue;}if(ly[i]<-ls)continue;var a=Math.floor(T*(2+i%3)+i)&7;X.drawImage(LEAF,(lc[i]*8+a)*ls*R,0,ls*R,ls*R,lx[i]-ls/2,ly[i]-ls/2,ls,ls);}X.globalAlpha=1;}}
onDone(function(){tri=0;fr=1;lan=1;for(var i=0;i<LN;i++){lon[i]=1;lx[i]=Math.random()*W;ly[i]=-rnd(10,H*0.6);lv[i]=rnd(45,95);lu[i]=rnd(-14,14);lc[i]=i%5===0?2:(i%2);}});`,
  { prelude: OFFSCREEN }
);

// --- Orbital ------------------------------------------------------------------------

const ORBITAL = canvasScene(
  `MF=30;
var BG,RK,UP,FLM,PUF,FLS,SAT,SWP,rw=7,rh=56,PR=1,pcx=0,pcy=0,rx1=1,ry1=1,cx2=0,cy2=0,rx2=1,ry2=1,RX=0,RY=0,sw=0,sd=0,
PX=new Float32Array(4),PY=new Float32Array(4),PB=new Uint8Array(4),K=[],RN=6,nL=1.5,nD=7,salvo=0,salT=0,
SN=200,sx=new Float32Array(SN),sy=new Float32Array(SN),su=new Float32Array(SN),sv=new Float32Array(SN),sl=new Float32Array(SN),sm=new Float32Array(SN),ss=new Float32Array(SN),si=0,
FX=new Float32Array(4),FY=new Float32Array(4),FT=new Float32Array(4),NFL=0,TW=new Float32Array(90),SA=new Float32Array([-0.35,-0.05,0.25,-0.7,0.3]);
for(var i=0;i<RN;i++)K.push({on:0,k:0,x:0,y:0,vx:0,vy:0,a:0,va:0,t:0,sd:1,p:-1,sep:0,al:1,burn:0,dec:0});
function limb(x){var d=x-pcx;return pcy-Math.sqrt(Math.max(0,PR*PR-d*d));}
function rad(c,s,a,b){var g=c.g,q=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);q.addColorStop(0,a);q.addColorStop(0.4,b);q.addColorStop(1,"rgba(0,0,0,0)");g.fillStyle=q;g.fillRect(0,0,s,s);return c;}
function body(g,w,h,nose){var b=g.createLinearGradient(-w/2,0,w/2,0);b.addColorStop(0,"#7d889a");b.addColorStop(0.35,"#eef2f8");b.addColorStop(0.7,"#b9c3d1");b.addColorStop(1,"#5d6778");g.fillStyle=b;g.beginPath();g.moveTo(-w/2,0);g.lineTo(-w/2,-h+nose);if(nose)g.quadraticCurveTo(-w/2,-h,0,-h-nose*0.2);if(nose)g.quadraticCurveTo(w/2,-h,w/2,-h+nose);else g.lineTo(w/2,-h);g.lineTo(w/2,0);g.fill();}
function onSize(){PR=Math.max(W*1.25,H*1.6);pcx=W/2;pcy=H*0.78+PR;rx1=PR*1.045;ry1=PR*1.03;cx2=W/2;cy2=-H*0.55;rx2=W*0.72;ry2=H*0.78;RX=W-72;RY=Math.max(96,H*0.12);rw=Math.max(5,Math.min(11,H*0.009));rh=rw*8;
var PFX=[0.05,0.13,0.87,0.95];for(var j=0;j<4;j++){PX[j]=W*PFX[j];PY[j]=limb(PX[j])-2;}
BG=mk(W,H);var g=BG.g,q=g.createLinearGradient(0,0,0,H);q.addColorStop(0,"#02030a");q.addColorStop(0.6,"#040714");q.addColorStop(1,"#081129");g.fillStyle=q;g.fillRect(0,0,W,H);
for(var i=0;i<Math.min(320,W*H/5000);i++){g.globalAlpha=rnd(0.12,0.55);g.fillStyle=Math.random()<0.15?"#ffd1f4":"#d6ecff";var z=Math.random()<0.15?1.6:0.9;g.fillRect(Math.random()*W,Math.random()*H*0.85,z,z);}g.globalAlpha=1;
g.strokeStyle="rgba(80,220,255,0.022)";g.lineWidth=1;g.beginPath();for(var x=36;x<W;x+=72){g.moveTo(x,0);g.lineTo(x,H);}for(var y=36;y<H;y+=72){g.moveTo(0,y);g.lineTo(W,y);}g.stroke();
g.setLineDash([6,9]);g.lineWidth=1;g.strokeStyle="rgba(255,90,220,0.14)";g.beginPath();g.ellipse(cx2,cy2,rx2,ry2,0,0,6.2832);g.stroke();g.strokeStyle="rgba(80,220,255,0.16)";g.beginPath();g.ellipse(pcx,pcy,rx1,ry1,0,0,6.2832);g.stroke();g.setLineDash([]);
q=g.createRadialGradient(pcx,pcy,PR*0.97,pcx,pcy,PR*1.07);q.addColorStop(0,"rgba(40,140,255,0)");q.addColorStop(0.3,"rgba(60,210,255,0.5)");q.addColorStop(0.45,"rgba(150,90,255,0.22)");q.addColorStop(0.62,"rgba(255,70,210,0.08)");q.addColorStop(1,"rgba(255,70,210,0)");g.fillStyle=q;g.fillRect(0,pcy-PR*1.08,W,H);
q=g.createLinearGradient(0,pcy-PR,0,H);q.addColorStop(0,"#0b1836");q.addColorStop(1,"#050913");g.fillStyle=q;g.beginPath();g.arc(pcx,pcy,PR,0,6.2832);g.fill();
g.save();g.beginPath();g.arc(pcx,pcy,PR,0,6.2832);g.clip();g.strokeStyle="rgba(80,220,255,0.07)";g.beginPath();for(var k=1;k<6;k++){g.moveTo(pcx+PR-k*H*0.03,pcy);g.arc(pcx,pcy,PR-k*H*0.03,0,6.2832);}for(var k=-14;k<=14;k++){var a=-1.5708+k*0.05;g.moveTo(pcx+Math.cos(a)*PR*0.6,pcy+Math.sin(a)*PR*0.6);g.lineTo(pcx+Math.cos(a)*PR,pcy+Math.sin(a)*PR);}g.stroke();g.restore();
g.strokeStyle="rgba(130,240,255,0.75)";g.lineWidth=1.4;g.beginPath();g.arc(pcx,pcy,PR,3.1416,6.2832);g.stroke();
for(var j=0;j<4;j++){g.fillStyle="#1c2a44";g.fillRect(PX[j]-rw*1.8,PY[j],rw*3.6,3);g.fillStyle="rgba(80,220,255,0.6)";g.fillRect(PX[j]-rw*1.8,PY[j],rw*3.6,1);}
g.strokeStyle="rgba(80,220,255,0.35)";g.lineWidth=1.2;var m=18,L=22;g.beginPath();g.moveTo(m,m+L);g.lineTo(m,m);g.lineTo(m+L,m);g.moveTo(W-m-L,m);g.lineTo(W-m,m);g.lineTo(W-m,m+L);g.moveTo(m,H-m-L);g.lineTo(m,H-m);g.lineTo(m+L,H-m);g.moveTo(W-m-L,H-m);g.lineTo(W-m,H-m);g.lineTo(W-m,H-m-L);g.stroke();
g.strokeStyle="rgba(80,220,255,0.14)";g.beginPath();for(var y=60;y<H-60;y+=24){var t=(y/24)%4===0?10:5;g.moveTo(6,y);g.lineTo(6+t,y);g.moveTo(W-6,y);g.lineTo(W-6-t,y);}g.stroke();
g.font="10px ui-monospace,Menlo,Consolas,monospace";g.fillStyle="rgba(120,230,255,0.45)";g.textAlign="right";g.fillText("ORB 412.7 KM  INC 51.6",W-m-4,H-m-8);g.fillStyle="rgba(255,120,220,0.4)";g.fillText("PAD A/B/C/D  WX GO",W-m-4,H-m-22);
g.strokeStyle="rgba(80,220,255,0.18)";g.beginPath();g.arc(RX,RY,34,0,6.2832);g.moveTo(RX+20,RY);g.arc(RX,RY,20,0,6.2832);g.moveTo(RX-38,RY);g.lineTo(RX+38,RY);g.moveTo(RX,RY-38);g.lineTo(RX,RY+38);g.stroke();
var fw=rw*1.9;RK=mk(fw,rh);g=RK.g;g.translate(fw/2,rh);body(g,rw,rh,rw*1.5);g.fillStyle="#1a2132";g.fillRect(-rw/2,-rh*0.8,rw,rh*0.07);g.fillRect(-rw*0.95,-rh*0.78,rw*0.45,rw*0.35);g.fillRect(rw*0.5,-rh*0.78,rw*0.45,rw*0.35);g.fillStyle="#2fd6f5";g.fillRect(-rw/2,-rh*0.45,rw,Math.max(1,rh*0.015));g.fillStyle="#394253";g.fillRect(-rw/2,-rh*0.05,rw,rh*0.05);
UP=mk(fw,rw*4.5);g=UP.g;g.translate(fw/2,rw*4.5);g.fillStyle="#2a3140";g.beginPath();g.moveTo(-rw*0.45,0);g.lineTo(-rw*0.2,-rw*0.6);g.lineTo(rw*0.2,-rw*0.6);g.lineTo(rw*0.45,0);g.fill();g.translate(0,-rw*0.6);body(g,rw,rw*3.3,rw*1.4);
FLM=mk(32,128);g=FLM.g;q=g.createLinearGradient(0,0,0,128);q.addColorStop(0,"rgba(255,255,255,1)");q.addColorStop(0.15,"rgba(255,225,170,0.95)");q.addColorStop(0.45,"rgba(255,140,60,0.6)");q.addColorStop(0.75,"rgba(255,70,170,0.25)");q.addColorStop(1,"rgba(255,70,170,0)");g.fillStyle=q;g.beginPath();g.moveTo(9,0);g.quadraticCurveTo(0,40,16,128);g.quadraticCurveTo(32,40,23,0);g.fill();
PUF=rad(mk(32,32),32,"rgba(175,190,215,0.55)","rgba(150,165,195,0.25)");FLS=rad(mk(64,64),64,"rgba(255,255,255,1)","rgba(120,230,255,0.5)");
SAT=mk(16,8);g=SAT.g;g.fillStyle="#8fa3bd";g.fillRect(6,2,4,4);g.fillStyle="#2fa6d0";g.fillRect(0,3,5,2);g.fillRect(11,3,5,2);
SWP=mk(80,80);g=SWP.g;if(g.createConicGradient){q=g.createConicGradient(0,40,40);q.addColorStop(0,"rgba(80,230,255,0.4)");q.addColorStop(0.16,"rgba(80,230,255,0)");q.addColorStop(1,"rgba(80,230,255,0)");g.fillStyle=q;g.beginPath();g.arc(40,40,34,0,6.2832);g.fill();}g.strokeStyle="rgba(120,240,255,0.6)";g.beginPath();g.moveTo(40,40);g.lineTo(74,40);g.stroke();
for(var i=0;i<30;i++){TW[i*3]=Math.random()*W;TW[i*3+1]=Math.random()*H*0.7;TW[i*3+2]=Math.random()*6.3;}
if(!sd){sd=1;var o=K[0];o.on=1;o.k=4;o.p=1;PB[1]=1;o.x=PX[1];o.y=PY[1];o.t=-25;o.al=1;o.a=0;}else for(var i=0;i<RN;i++){var o=K[i];if(o.on&&o.k===4&&o.p>=0){o.x=PX[o.p];o.y=PY[o.p];}}}
function free(){for(var i=0;i<RN;i++)if(!K[i].on)return K[i];return null;}
function pad(){var s=Math.floor(Math.random()*4);for(var q=0;q<4;q++){var j=(s+q)%4;if(!PB[j])return j;}return -1;}
function launch(sep){var o=free(),p=pad();if(!o||p<0)return;o.on=1;o.k=0;o.p=p;PB[p]=1;o.x=PX[p];o.y=PY[p];o.vx=o.vy=0;o.a=0;o.t=0;o.sd=PX[p]<W/2?-1:1;o.sep=sep;o.al=1;}
function land(){var o=free(),p=pad();if(!o||p<0)return;o.on=1;o.k=3;o.p=p;PB[p]=1;o.sd=PX[p]<W/2?-1:1;o.x=PX[p]+o.sd*W*0.04;o.y=-rh;o.vx=0;o.vy=H*0.26;o.a=0;o.t=0;o.burn=0;o.al=1;}
function puff(x,y,u,v,l,s){sx[si]=x;sy[si]=y;su[si]=u;sv[si]=v;sl[si]=sm[si]=l;ss[si]=s;si=(si+1)%SN;}
function flash(x,y){FX[NFL]=x;FY[NFL]=y;FT[NFL]=0.001;NFL=(NFL+1)%4;}
function draw(dt){var i,m=1+1.5*wk;
X.globalCompositeOperation="source-over";X.globalAlpha=1;X.drawImage(BG,0,0,W,H);
X.globalCompositeOperation="lighter";X.fillStyle="#dff4ff";for(i=0;i<30;i++){X.globalAlpha=0.15+0.4*(0.5+0.5*Math.sin(T*1.3+TW[i*3+2]));X.fillRect(TW[i*3],TW[i*3+1],1.3,1.3);}
sw+=dt*1.3;var c=Math.cos(sw),s=Math.sin(sw);X.globalAlpha=0.8;X.setTransform(R*c,R*s,-R*s,R*c,R*RX,R*RY);X.drawImage(SWP,-40,-40,80,80);X.setTransform(R,0,0,R,0,0);
X.strokeStyle="rgba(120,235,255,0.5)";X.lineWidth=1;for(i=0;i<5;i++){var o2=i>2,th=SA[i]+=dt*(o2?0.02:0.011)*m,lim=o2?1.05:0.42;if(th>lim)SA[i]=th=-lim;var x,y,ph;if(o2){x=cx2+rx2*Math.sin(th);y=cy2+ry2*Math.cos(th);ph=1.5708-th;X.globalAlpha=0.35;X.beginPath();X.ellipse(cx2,cy2,rx2,ry2,0,ph,ph+0.07);X.stroke();}else{x=pcx+rx1*Math.sin(th);y=pcy-ry1*Math.cos(th);ph=th-1.5708;X.globalAlpha=0.35;X.beginPath();X.ellipse(pcx,pcy,rx1,ry1,0,ph-0.035,ph);X.stroke();}
X.globalAlpha=0.9;X.drawImage(SAT,x-8,y-4,16,8);if((T*1.4+i*0.37)%1<0.12){X.fillStyle=i%2?"#ff5cd6":"#5ef0ff";X.fillRect(x-1.5,y-1.5,3,3);}}
for(i=0;i<4;i++){X.globalAlpha=(T*0.8+i*0.25)%1<0.5?0.85:0.25;X.fillStyle=i%2?"#ff5cd6":"#5ef0ff";X.fillRect(PX[i]-rw*1.8-1,PY[i]-1,2,2);X.fillRect(PX[i]+rw*1.8-1,PY[i]-1,2,2);}
nL-=dt;nD-=dt;if(wk>0.5&&nL>6)nL=rnd(0.8,2.5);if(nL<=0){launch(0);nL=wk>0.5?rnd(3,5.5):rnd(9,15);}if(nD<=0){land();nD=wk>0.5?rnd(7,10):rnd(15,24);}
if(salvo>0){salT-=dt;if(salT<=0){launch(1);salvo--;salT=0.6;}}
X.globalCompositeOperation="source-over";for(i=0;i<SN;i++){if(sl[i]<=0)continue;sl[i]-=dt;var q=1-sl[i]/sm[i];su[i]*=1-0.5*dt;sx[i]+=su[i]*dt;sy[i]+=sv[i]*dt;var z=ss[i]*(1+q*4);X.globalAlpha=0.28*(1-q);X.drawImage(PUF,sx[i]-z/2,sy[i]-z/2,z,z);}
for(i=0;i<RN;i++){var o=K[i];if(!o.on)continue;o.t+=dt;var k=o.k,fl=0;
if(k===0||k===1){var ac=H*(k?0.075:0.055)*(1+0.25*wk);o.a=o.sd*Math.min(1.2,Math.max(0,o.t-0.8)*0.2);o.vx+=Math.sin(o.a)*ac*dt;o.vy-=Math.cos(o.a)*ac*dt;o.x+=o.vx*dt;o.y+=o.vy*dt;fl=rh*(k?0.4:0.6);
if(o.p>=0&&o.t>1.5){PB[o.p]=0;o.p=-1;}if(dt>0&&Math.random()<dt*(o.y>H*0.6?26:9))puff(o.x-Math.sin(o.a)*2,o.y+Math.cos(o.a)*2,rnd(-14,14)+(o.y>PY[0]-rh?o.sd*-30:0),rnd(-4,8),rnd(2.5,4.5),rw*(o.y>H*0.6?1.8:1.1));
if(k===0&&o.sep&&o.t>3.1){flash(o.x,o.y-rh*0.95);o.k=1;var b=free();if(b){b.on=1;b.k=2;b.x=o.x;b.y=o.y;b.vx=o.vx*0.55;b.vy=o.vy*0.55;b.a=o.a;b.va=-o.sd*0.9;b.t=0;b.al=1;b.p=-1;}}
if(o.y<-rh*1.5||o.x<-rh*1.5||o.x>W+rh*1.5){o.on=0;if(o.p>=0)PB[o.p]=0;continue;}}
else if(k===2){o.vy+=H*0.05*dt;o.x+=o.vx*dt;o.y+=o.vy*dt;o.a+=o.va*dt;o.al=Math.max(0,1-o.t/3);if(o.al<=0){o.on=0;continue;}}
else if(k===3){var ty=PY[o.p];o.x+=(PX[o.p]-o.x)*Math.min(1,dt*0.9);if(!o.burn&&o.y>ty-H*0.32){o.burn=1;o.dec=o.vy*o.vy/(2*Math.max(1,ty-o.y));}if(o.burn){o.vy=Math.max(H*0.015,o.vy-o.dec*dt);fl=rh*0.45;if(dt>0&&Math.random()<dt*14)puff(o.x,o.y,rnd(-20,20),rnd(-6,2),rnd(1.5,3),rw*1.2);}o.y+=o.vy*dt;if(o.y>=ty){o.y=ty;o.k=4;o.t=0;for(var j=0;j<8;j++)puff(o.x,ty-2,rnd(-40,40),rnd(-10,0),rnd(1.5,3),rw*1.3);}}
else if(k===4){if(o.t>2.5)o.al=Math.max(0,1-(o.t-2.5));if(o.al<=0){o.on=0;if(o.p>=0)PB[o.p]=0;o.p=-1;continue;}}
var cs=Math.cos(o.a),sn=Math.sin(o.a);X.setTransform(R*cs,R*sn,-R*sn,R*cs,R*o.x,R*o.y);X.globalAlpha=o.al;X.globalCompositeOperation="source-over";
if(k===1)X.drawImage(UP,-UP.w/2,-UP.h,UP.w,UP.h);else X.drawImage(RK,-RK.w/2,-rh,RK.w,rh);
if(k>=3&&(k===4||o.burn)){var lg=k===4?1:Math.min(1,(o.y-(PY[o.p]-H*0.32))/(H*0.25));X.strokeStyle="#9aa6b8";X.lineWidth=Math.max(1,rw*0.18);X.beginPath();X.moveTo(-rw*0.45,-rh*0.14);X.lineTo(-rw*(0.45+0.85*lg),-rh*0.14*(1-lg));X.moveTo(rw*0.45,-rh*0.14);X.lineTo(rw*(0.45+0.85*lg),-rh*0.14*(1-lg));X.stroke();}
if(fl){X.globalCompositeOperation="lighter";var f=fl*(0.85+0.3*Math.random());X.globalAlpha=0.95;X.drawImage(FLM,-rw*0.75,-1,rw*1.5,f);X.globalAlpha=0.35;X.drawImage(FLS,-rw*2.5,-rw*2.5,rw*5,rw*5);}}
X.setTransform(R,0,0,R,0,0);X.globalCompositeOperation="lighter";
for(i=0;i<4;i++){if(FT[i]<=0)continue;FT[i]+=dt;var q=FT[i]/0.7;if(q>=1){FT[i]=0;continue;}var z=rw*(4+q*34);X.globalAlpha=1-q;X.drawImage(FLS,FX[i]-z/2,FY[i]-z/2,z,z);}
X.globalCompositeOperation="source-over";}
onDone(function(){salvo=3;salT=0;});`,
  { prelude: OFFSCREEN }
);

// --- Themes -------------------------------------------------------------------------

const theme = (fields) => ({ builtIn: true, saved: true, appearance: 'dark', ...fields });

export const BUILTIN_THEMES = Object.freeze([
  theme({
    id: 'builtin-aurora',
    name: 'Aurora',
    description: 'Slow aurora curtains over a starry teal and indigo night.',
    tokens: {
      'bg-base': '#07111a',
      'bg-raised': '#0a1621',
      'bg-surface': '#10202d',
      'bg-elevated': '#162a39',
      'bg-hover': '#1d3445',
      'settings-sidebar-bg': '#060e16',
      'border-subtle': 'rgb(160 230 255 / 6%)',
      'border-default': 'rgb(160 230 255 / 9%)',
      'border-strong': 'rgb(160 230 255 / 15%)',
      'text-primary': '#e6f4f5',
      'text-secondary': '#a3c1c8',
      'text-muted': '#6d8b94',
      accent: '#14a586',
      'on-accent': '#07111a',
      'accent-soft': 'rgb(40 210 170 / 14%)',
      'accent-glow': 'rgb(40 210 170 / 28%)',
      link: '#86e8d2',
      'agent-violet': '#a58bff',
      success: '#4ade9b',
      warning: '#f5b86a',
      danger: '#ff7b8a',
    },
    baseOpacity: 0.52,
    surfaceOpacity: 0.64,
    panelBlur: 16,
    backdrop: { type: 'html', html: AURORA, dim: 0 },
  }),
  theme({
    id: 'builtin-synthwave',
    name: 'Neon Horizon',
    description: 'A striped sunset over a neon grid racing toward you.',
    tokens: {
      'bg-base': '#0f0618',
      'bg-raised': '#150a22',
      'bg-surface': '#1e1030',
      'bg-elevated': '#28163d',
      'bg-hover': '#34204d',
      'settings-sidebar-bg': '#0b0414',
      'border-subtle': 'rgb(255 120 220 / 7%)',
      'border-default': 'rgb(255 120 220 / 11%)',
      'border-strong': 'rgb(255 120 220 / 18%)',
      'text-primary': '#f7ecff',
      'text-secondary': '#c9aedb',
      'text-muted': '#8e74a3',
      accent: '#f2409f',
      'on-accent': '#0f0618',
      'accent-soft': 'rgb(242 64 159 / 16%)',
      'accent-glow': 'rgb(242 64 159 / 32%)',
      link: '#ff8fd2',
      'agent-violet': '#4fdcf5',
      success: '#5cf2b0',
      warning: '#ffc65c',
      danger: '#ff5c7a',
    },
    baseOpacity: 0.55,
    surfaceOpacity: 0.76,
    panelBlur: 12,
    backdrop: { type: 'html', html: NEON_HORIZON, dim: 0.18 },
  }),
  theme({
    id: 'builtin-ember',
    name: 'Ember',
    description: 'Warm charcoal with glowing embers rising from the heat below.',
    tokens: {
      'bg-base': '#110d0b',
      'bg-raised': '#16110e',
      'bg-surface': '#201814',
      'bg-elevated': '#2a201a',
      'bg-hover': '#352821',
      'settings-sidebar-bg': '#0d0a08',
      'border-subtle': 'rgb(255 200 150 / 6%)',
      'border-default': 'rgb(255 200 150 / 9%)',
      'border-strong': 'rgb(255 200 150 / 15%)',
      'text-primary': '#f6ede5',
      'text-secondary': '#c7b0a0',
      'text-muted': '#8c7768',
      accent: '#e9661f',
      'on-accent': '#110d0b',
      'accent-soft': 'rgb(240 120 50 / 15%)',
      'accent-glow': 'rgb(240 120 50 / 30%)',
      link: '#ffa262',
      'agent-violet': '#c49bff',
      success: '#7ed492',
      warning: '#ffc44d',
      danger: '#ff6b5b',
    },
    baseOpacity: 0.52,
    surfaceOpacity: 0.74,
    panelBlur: 10,
    backdrop: { type: 'html', html: EMBER, dim: 0.08 },
  }),
  theme({
    id: 'builtin-abyss',
    name: 'Abyss',
    description: 'Deep water, drifting light and glowing plankton that follow your cursor.',
    tokens: {
      'bg-base': '#03121a',
      'bg-raised': '#051821',
      'bg-surface': '#0a222d',
      'bg-elevated': '#102d3a',
      'bg-hover': '#163948',
      'settings-sidebar-bg': '#020d13',
      'border-subtle': 'rgb(120 240 230 / 6%)',
      'border-default': 'rgb(120 240 230 / 9%)',
      'border-strong': 'rgb(120 240 230 / 15%)',
      'text-primary': '#e2f6f6',
      'text-secondary': '#9cc6c9',
      'text-muted': '#628d92',
      accent: '#10a091',
      'on-accent': '#03121a',
      'accent-soft': 'rgb(40 220 200 / 14%)',
      'accent-glow': 'rgb(40 220 200 / 28%)',
      link: '#5fe3d3',
      'agent-violet': '#a08cff',
      success: '#4fe39a',
      warning: '#f2c46b',
      danger: '#ff7a85',
    },
    baseOpacity: 0.5,
    surfaceOpacity: 0.72,
    panelBlur: 14,
    backdrop: { type: 'html', html: ABYSS, dim: 0.06 },
  }),
  theme({
    id: 'builtin-phosphor',
    name: 'Phosphor',
    description: 'A green phosphor terminal with soft scanlines and drifting glyphs.',
    tokens: {
      'bg-base': '#030b05',
      'bg-raised': '#051008',
      'bg-surface': '#08180c',
      'bg-elevated': '#0c2112',
      'bg-hover': '#112b18',
      'settings-sidebar-bg': '#020803',
      'shell-bg': '#040d06',
      'border-subtle': 'rgb(120 255 150 / 8%)',
      'border-default': 'rgb(120 255 150 / 12%)',
      'border-strong': 'rgb(120 255 150 / 20%)',
      'text-primary': '#b8f5c4',
      'text-secondary': '#80c68f',
      'text-muted': '#518c5f',
      accent: '#2a9e55',
      'on-accent': '#030b05',
      'accent-soft': 'rgb(80 230 130 / 14%)',
      'accent-glow': 'rgb(80 230 130 / 28%)',
      link: '#72f0c0',
      'agent-violet': '#7fe3d0',
      success: '#6cf08e',
      warning: '#e6d36a',
      danger: '#ff7a6b',
      'font-ui': "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace",
      'font-mono': "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace",
      'radius-sm': '2px',
      'radius-md': '3px',
      'radius-lg': '4px',
      'radius-xl': '4px',
    },
    baseOpacity: 0.6,
    surfaceOpacity: 0.76,
    panelBlur: 6,
    backdrop: { type: 'html', html: PHOSPHOR, dim: 0.6 },
    overlay: { html: PHOSPHOR_OVERLAY },
  }),
  theme({
    id: 'builtin-starfield',
    name: 'Starfield',
    description: 'Drifting stars that stretch into warp streaks while agents work.',
    tokens: {
      'bg-base': '#05060f',
      'bg-raised': '#080a17',
      'bg-surface': '#0f1224',
      'bg-elevated': '#161a31',
      'bg-hover': '#1e233f',
      'settings-sidebar-bg': '#04050c',
      'border-subtle': 'rgb(170 190 255 / 6%)',
      'border-default': 'rgb(170 190 255 / 9%)',
      'border-strong': 'rgb(170 190 255 / 15%)',
      'text-primary': '#eceffd',
      'text-secondary': '#a6adcb',
      'text-muted': '#6e7595',
      accent: '#1c9fd8',
      'on-accent': '#05060f',
      'accent-soft': 'rgb(40 180 240 / 15%)',
      'accent-glow': 'rgb(40 180 240 / 30%)',
      link: '#6cc8ff',
      'agent-violet': '#a78bfa',
      success: '#3ddc97',
      warning: '#f6c453',
      danger: '#ff6b7d',
    },
    baseOpacity: 0.5,
    surfaceOpacity: 0.7,
    panelBlur: 10,
    backdrop: { type: 'html', html: STARFIELD, dim: 0 },
  }),
  theme({
    id: 'builtin-imperium',
    name: 'Imperium',
    description: 'Dusk over a torchlit amphitheater while legions march past below.',
    tokens: {
      'bg-base': '#15100c',
      'bg-raised': '#1b140f',
      'bg-surface': '#251b14',
      'bg-elevated': '#30231a',
      'bg-hover': '#3b2b20',
      'settings-sidebar-bg': '#110c09',
      'border-subtle': 'rgb(240 205 150 / 7%)',
      'border-default': 'rgb(240 205 150 / 10%)',
      'border-strong': 'rgb(240 205 150 / 17%)',
      'text-primary': '#f5ecdc',
      'text-secondary': '#cdbb9f',
      'text-muted': '#94826b',
      accent: '#e5525f',
      'on-accent': '#15100c',
      'accent-soft': 'rgb(229 82 95 / 15%)',
      'accent-glow': 'rgb(229 82 95 / 30%)',
      link: '#e8c06a',
      'agent-violet': '#b98cf2',
      success: '#9ccc65',
      warning: '#f0b84a',
      danger: '#ff6f61',
    },
    baseOpacity: 0.55,
    surfaceOpacity: 0.76,
    panelBlur: 12,
    backdrop: { type: 'html', html: IMPERIUM, dim: 0.04 },
  }),
  theme({
    id: 'builtin-orbital',
    name: 'Orbital',
    description: 'A neon mission-control view of reusable boosters launching and landing over a planet.',
    tokens: {
      'bg-base': '#04060d',
      'bg-raised': '#070a14',
      'bg-surface': '#0c1120',
      'bg-elevated': '#121a2e',
      'bg-hover': '#19233c',
      'settings-sidebar-bg': '#03050b',
      'border-subtle': 'rgb(90 220 255 / 7%)',
      'border-default': 'rgb(90 220 255 / 10%)',
      'border-strong': 'rgb(90 220 255 / 17%)',
      'text-primary': '#e8f4ff',
      'text-secondary': '#a2b6cf',
      'text-muted': '#687b93',
      accent: '#2fd6f5',
      'on-accent': '#04060d',
      'accent-soft': 'rgb(47 214 245 / 14%)',
      'accent-glow': 'rgb(47 214 245 / 28%)',
      link: '#7fe9ff',
      'agent-violet': '#ff6bdc',
      success: '#3ee6a0',
      warning: '#ffc857',
      danger: '#ff5c7a',
    },
    baseOpacity: 0.52,
    surfaceOpacity: 0.74,
    panelBlur: 12,
    backdrop: { type: 'html', html: ORBITAL, dim: 0 },
  }),
]);

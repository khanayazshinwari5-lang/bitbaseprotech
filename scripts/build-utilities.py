"""Generate the exact utility classes used by this static project (no CDN/compiler at runtime)."""
import re,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
classes=set()
for p in list(root.glob('*.html'))+list((root/'assets/js').glob('*.js')):
 for m in re.finditer(r'class(?:Name)?\s*[=:]\s*[\'\"]([^\'\"\n]+)',p.read_text()):
  classes.update(m[1].split())
colors={'white':'#fff','black':'#000','accent':'#f7931a','accent-orange':'#f7931a','accent-yellow':'#fdb022','accent-green':'#16c784','accent-blue':'#4169e1','accent-purple':'#8b5cf6','text-primary':'#fff','text-secondary':'#b0b0b0','text-tertiary':'grey','secondary':'#b0b0b0','bg-primary':'#0f0f0f','bg-secondary':'#1a1a1a','gray-300':'#d1d5db','gray-400':'#9ca3af','transparent':'transparent'}
def val(s):
 if s.startswith('[') and s.endswith(']'): return re.sub(r'(?<=\w)([+-])(?=\d)',r' \1 ',s[1:-1].replace('_',' '))
 if s=='full':return '100%'
 if s=='screen':return '100vh'
 if s=='px':return '1px'
 if s=='auto':return 'auto'
 if '/' in s:
  try:a,b=s.split('/');return str(float(a)/float(b)*100)+'%'
  except:return None
 try:return str(float(s)/4)+'rem'
 except:return None
def color(s):
 base,_,alpha=s.partition('/')
 c=colors.get(base) or (base[1:-1] if base.startswith('[#') and base.endswith(']') else None)
 if not c:return None
 if alpha:
  a=float(alpha[1:-1]) if alpha.startswith('[') else float(alpha)/100
  if c.startswith('#'):
   h=c[1:];h=''.join(x*2 for x in h) if len(h)==3 else h
   return 'rgba('+','.join(str(int(h[i:i+2],16)) for i in (0,2,4))+','+str(a)+')'
 return c
static={'flex':'display:flex','inline-flex':'display:inline-flex','block':'display:block','inline-block':'display:inline-block','inline':'display:inline','hidden':'display:none','grid':'display:grid','flex-col':'flex-direction:column','flex-row':'flex-direction:row','flex-wrap':'flex-wrap:wrap','flex-1':'flex:1 1 0%','flex-shrink-0':'flex-shrink:0','items-center':'align-items:center','items-start':'align-items:flex-start','items-stretch':'align-items:stretch','items-baseline':'align-items:baseline','justify-center':'justify-content:center','justify-between':'justify-content:space-between','relative':'position:relative','absolute':'position:absolute','fixed':'position:fixed','inset-0':'inset:0','overflow-hidden':'overflow:hidden','overflow-x-hidden':'overflow-x:hidden','overflow-x-auto':'overflow-x:auto','object-cover':'object-fit:cover','whitespace-nowrap':'white-space:nowrap','uppercase':'text-transform:uppercase','underline':'text-decoration-line:underline','cursor-pointer':'cursor:pointer','antialiased':'-webkit-font-smoothing:antialiased','border':'border-width:1px','border-2':'border-width:2px','border-b':'border-bottom-width:1px','border-t':'border-top-width:1px','border-y':'border-block-width:1px','border-t-transparent':'border-top-color:transparent','max-w-md':'max-width:28rem','-translate-y-1/2':'transform:translateY(-50%)','leading-tight':'line-height:1.25','leading-relaxed':'line-height:1.625','tracking-tight':'letter-spacing:-.025em','tracking-wide':'letter-spacing:.025em','tracking-wider':'letter-spacing:.05em','snap-x':'scroll-snap-type:x var(--snap-strictness,proximity)','snap-mandatory':'--snap-strictness:mandatory','snap-center':'scroll-snap-align:center','sr-only':'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0','animate-spin':'animation:bb-spin 1s linear infinite'}
fonts={'heading':"'Space Grotesk',sans-serif",'body':"Inter,sans-serif",'mono':"'IBM Plex Mono',monospace",'sans':'ui-sans-serif,system-ui,sans-serif'}
sizes={'xs':('.75rem','1rem'),'sm':('.875rem','1.25rem'),'lg':('1.125rem','1.75rem'),'xl':('1.25rem','1.75rem'),'2xl':('1.5rem','2rem'),'3xl':('1.875rem','2.25rem'),'4xl':('2.25rem','2.5rem'),'5xl':('3rem','1')}
def rule(c):
 if c in static:return static[c]
 if c.startswith('font-'):
  n=c[5:];return 'font-family:'+fonts[n] if n in fonts else 'font-weight:'+{'medium':'500','semibold':'600','bold':'700'}.get(n,'400')
 if c.startswith('text-'):
  n=c[5:]
  if n in ['left','center','right']:return 'text-align:'+n
  if n in sizes:return 'font-size:'+sizes[n][0]+';line-height:'+sizes[n][1]
  if n.startswith('['):return 'font-size:'+val(n)
  v=color(n);return 'color:'+v if v else None
 for prefix,prop in [('bg-','background-color'),('border-','border-color'),('fill-','fill')]:
  if c.startswith(prefix):
   v=color(c[len(prefix):]);return prop+':'+v if v else None
 if c.startswith('rounded'):
  n=c[8:];return 'border-radius:'+({'':'0.25rem','md':'.375rem','lg':'.5rem','xl':'.75rem','2xl':'1rem','full':'9999px'}.get(n) or val(n) or '.25rem')
 if c.startswith('grid-cols-'):return 'grid-template-columns:repeat('+c[10:]+',minmax(0,1fr))'
 if c.startswith('col-span-'):return 'grid-column:span '+c[9:]+' / span '+c[9:]
 if c.startswith('opacity-'):return 'opacity:'+str(float(c[8:])/100)
 if c.startswith('duration-'):return 'transition-duration:'+c[9:]+'ms'
 if c.startswith('transition-'):
  n=c[11:];return 'transition-property:'+{'all':'all','colors':'color,background-color,border-color','opacity':'opacity','transform':'transform'}.get(n,n)+';transition-duration:150ms'
 if c.startswith('backdrop-blur-'):return 'backdrop-filter:blur('+({'sm':'4px','md':'12px'}.get(c[14:]) or val(c[14:]))+')'
 if c.startswith('scale-'):return 'transform:scale('+val(c[6:])+')'
 if c.startswith('translate-x-'):return 'transform:translateX('+val(c[12:])+')'
 if c.startswith('tracking-'):return 'letter-spacing:'+val(c[9:])
 if c.startswith('leading-'):return 'line-height:'+val(c[8:])
 if c.startswith('z-'):return 'z-index:'+c[2:].strip('[]')
 prefixes={'min-h':'min-height','min-w':'min-width','max-w':'max-width','w':'width','h':'height','gap-x':'column-gap','gap-y':'row-gap','gap':'gap','top':'top','bottom':'bottom','left':'left','right':'right','p':'padding','px':'padding-inline','py':'padding-block','pt':'padding-top','pb':'padding-bottom','pl':'padding-left','pr':'padding-right','m':'margin','mx':'margin-inline','my':'margin-block','mt':'margin-top','mb':'margin-bottom','ml':'margin-left','mr':'margin-right'}
 for k,p in prefixes.items():
  if c.startswith(k+'-'):
   v=val(c[len(k)+1:]);return p+':'+v if v else None
 return None
reset='''/* Static utilities. Regenerate with python3 scripts/build-utilities.py. */
*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:#e5e7eb}html{line-height:1.5;-webkit-text-size-adjust:100%;tab-size:4}body{margin:0}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;text-decoration:inherit}button,input,optgroup,select,textarea{font:inherit;color:inherit;margin:0;padding:0}button{background:transparent;cursor:pointer}img,svg,video,canvas{display:block;vertical-align:middle}img,video{max-width:100%;height:auto}table{border-collapse:collapse;text-indent:0}p,blockquote,dl,dd,h1,h2,h3,h4,h5,h6,hr,figure,pre{margin:0}ol,ul,menu{list-style:none;margin:0;padding:0}[hidden]{display:none}input::placeholder,textarea::placeholder{opacity:1;color:#9ca3af}@keyframes bb-spin{to{transform:rotate(360deg)}}
'''
reset+='''
@keyframes ticker-slow{to{transform:translateX(-50%)}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-20px)}}@keyframes gradient-shift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}@keyframes flash-up{from{background-color:rgba(22,199,132,.28)}to{background-color:transparent}}@keyframes flash-down{from{background-color:rgba(234,57,67,.28)}to{background-color:transparent}}
.animate-ticker-slow{animation:ticker-slow 140s linear infinite}.animate-float{animation:float 6s ease-in-out infinite}.animate-gradient-shift{animation:gradient-shift 4s ease-in-out infinite}.animate-pulse-dot{animation:pulse-dot 1.6s ease-in-out infinite}.animate-flash-up{animation:flash-up .7s ease-out}.animate-flash-down{animation:flash-down .7s ease-out}
'''
rules=[]
for cls in sorted(classes,key=lambda c:(next(({'sm':1,'md':2,'lg':3,'xl':4}[v] for v in c.split(':')[:-1] if v in ['sm','md','lg','xl']),0),':' in c,c)):
 parts=cls.split(':');base=parts[-1];decl=rule(base)
 if base.startswith('space-y-'):decl='margin-top:'+val(base[8:])
 if not decl:continue
 sel='.'+re.sub(r'([^a-zA-Z0-9_-])',r'\\\1',cls)
 if base.startswith('space-y-'):sel+=' > :not([hidden]) ~ :not([hidden])'
 for v in parts[:-1]:
  if v=='hover':sel+=':hover'
  elif v=='group-hover':sel='.group:hover '+sel
  elif v=='peer-checked':sel='.peer:checked ~ '+sel
 out=sel+'{'+decl+'}'
 for v in parts[:-1]:
  if v in ['sm','md','lg','xl']:out='@media(min-width:'+str({'sm':640,'md':768,'lg':1024,'xl':1280}[v])+'px){'+out+'}'
 rules.append(out)
(root/'assets/css/utilities.css').write_text(reset+'\n'.join(rules)+'\n')
print('Wrote',len(rules),'static utility rules')

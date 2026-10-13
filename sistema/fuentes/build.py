# Arma el dashboard: un HTML por módulo (cada uno con su propio ingreso).
#   index.html            Inicio (tarjetas)
#   pantera.html          Pantera Reportería — Martina
#   contabilidad.html     Dashboard Contabilidad (lector + Reportes específicos)
#   dashboard-legal.html  Dashboard de Legal (lector + Reportes específicos)
#   legal.html            Agente Legal
#   tareas.html           Seguimiento de tareas
#   usuarios.html         Usuarios y permisos (administradora)
import base64, os, datetime
d=lambda f:'data:image/png;base64,'+base64.b64encode(open(f,'rb').read()).decode()
LOGOS={'__LOGO_GOLD__':d('src/logo/gold.png'),'__LOGO_NAVY__':d('src/logo/navy.png'),'__LOGO_MYA__':d('src/logo/mya_white.png')}
V=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=5)).strftime('v%d-%m-%Y %H:%M')
URL=os.environ.get('SB_URL',''); ANON=os.environ.get('SB_ANON','')
AUTH=open('src/comun/ma_auth.html',encoding='utf-8').read()

def final(s):
    s=s.replace('<!--MA_AUTH-->',AUTH)
    for k,v in LOGOS.items(): s=s.replace(k,v)
    return s.replace('__SUPABASE_URL__',URL).replace('__SUPABASE_ANON__',ANON).replace('__VERSION__',V)

def escribir(nombre,s):
    s=final(s)
    assert '__SUPABASE' not in s and '__VERSION__' not in s and '<!--MA_AUTH-->' not in s, nombre
    open(nombre,'w',encoding='utf-8').write(s); print('built',nombre,len(s))

leer=lambda f:open(f,encoding='utf-8').read()
escribir('index.html',leer('src/inicio.html'))
escribir('pantera.html',leer('src/pantera.html').replace('__PANTERA_B64__',base64.b64encode(open('reporte_pantera.html','rb').read()).decode()))
escribir('usuarios.html',leer('src/usuarios.html'))
rep=leer('src/reportes_conta.html')
for archivo,titulo,carpeta,modulo,conRep in (('contabilidad.html','Dashboard Contabilidad','Contabilidad','contabilidad',True),('dashboard-legal.html','Dashboard de Legal','Legal','legal',True)):
    a=leer('src/lector_template.html').replace('__TITULO__',titulo).replace('__CARPETA__',carpeta).replace('__MODULO__',modulo)
    if conRep:
        a=a.replace('<!--REP_TABS-->','<div class="ltabs"><button class="ltab" data-v="lector" aria-selected="true">📁 Lector de carpeta</button><button class="ltab" data-v="reportes" aria-selected="false">📊 Reportes específicos</button></div>')
        a=a.replace('<!--REP_BOX-->','<div class="rep hidden" id="repBox"><div class="panel"><div class="rep-top"><b>Reportes específicos</b><button class="btn sm pri" id="repNuevo">＋ Nuevo</button></div><div id="repLista"></div><div class="rep-nota" id="repNota"></div></div><div class="panel" id="repMain"></div></div>')
        a=a.replace('<!--REP_JS-->',rep)
    else:
        a=a.replace('<!--REP_TABS-->','<span class="t">📁 Lector de carpeta</span>').replace('<!--REP_BOX-->','').replace('<!--REP_JS-->','')
    escribir(archivo,a)
escribir('legal.html',leer('src/legal.html'))
escribir('tareas.html',leer('src/tareas.html'))

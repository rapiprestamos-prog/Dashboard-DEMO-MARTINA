"""
Sincronizador OneDrive → Supabase (corre en GitHub Actions, sin intervención de nadie).

1. Lee en Supabase (tabla ma_carpetas) qué rutas de OneDrive hay que vigilar.
2. Entra a OneDrive por Microsoft Graph (App Registration, client credentials).
3. Recorre años/meses/archivos; sube a Storage los Excel nuevos o cambiados y
   registra sus metadatos en ma_archivos. Borra de la base los que ya no existen.

Variables de entorno (secrets del repositorio):
  SUPABASE_URL, SUPABASE_SERVICE_KEY        (service_role, NO la anon)
  MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
"""
import os, re, sys, time, unicodedata, requests
from datetime import datetime, timezone

SB_URL   = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY   = os.environ["SUPABASE_SERVICE_KEY"]
TENANT   = os.environ["MS_TENANT_ID"]
CLIENT   = os.environ["MS_CLIENT_ID"]
SECRET   = os.environ["MS_CLIENT_SECRET"]
BUCKET   = "reportes"
EXT      = re.compile(r"\.(xlsx|xlsm|xls|csv)$", re.I)
MESES    = ["ENERO","FEBRERO","MARZO","ABRIL","MAYO","JUNIO","JULIO","AGOSTO","SEPTIEMBRE","OCTUBRE","NOVIEMBRE","DICIEMBRE"]

SB = requests.Session()
SB.headers.update({"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"})

# ---------------------------------------------------------------- Supabase
def sb_select(tabla, params):
    r = SB.get(f"{SB_URL}/rest/v1/{tabla}", params=params); r.raise_for_status(); return r.json()

def sb_upsert(tabla, fila, conflicto):
    r = SB.post(f"{SB_URL}/rest/v1/{tabla}", params={"on_conflict": conflicto},
                headers={"Prefer": "resolution=merge-duplicates,return=representation"}, json=fila)
    r.raise_for_status(); return r.json()

def sb_delete(tabla, params):
    r = SB.delete(f"{SB_URL}/rest/v1/{tabla}", params=params); r.raise_for_status()

def sb_insert(tabla, fila):
    r = SB.post(f"{SB_URL}/rest/v1/{tabla}", headers={"Prefer": "return=representation"}, json=fila)
    r.raise_for_status(); return r.json()[0]

def sb_update(tabla, params, fila):
    r = SB.patch(f"{SB_URL}/rest/v1/{tabla}", params=params, json=fila); r.raise_for_status()

def storage_put(objeto, contenido):
    r = SB.post(f"{SB_URL}/storage/v1/object/{BUCKET}/{objeto}",
                headers={"x-upsert": "true", "Content-Type": "application/octet-stream"}, data=contenido)
    r.raise_for_status()

def storage_delete(objetos):
    if objetos:
        SB.delete(f"{SB_URL}/storage/v1/object/{BUCKET}", json={"prefixes": objetos})

# ---------------------------------------------------------------- Microsoft Graph
def token():
    r = requests.post(f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token", data={
        "client_id": CLIENT, "client_secret": SECRET,
        "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials"})
    r.raise_for_status(); return r.json()["access_token"]

class Graph:
    def __init__(self): self.h = {"Authorization": f"Bearer {token()}"}
    def get(self, url, **kw):
        for intento in range(4):
            r = requests.get(url, headers=self.h, **kw)
            if r.status_code == 429: time.sleep(int(r.headers.get("Retry-After", "5"))); continue
            r.raise_for_status(); return r
        r.raise_for_status()
    def hijos(self, cuenta, ruta):
        """Lista todos los elementos de una carpeta (con paginación)."""
        base = f"https://graph.microsoft.com/v1.0/users/{cuenta}/drive/root"
        url = f"{base}:{ruta}:/children" if ruta not in ("", "/") else f"{base}/children"
        url += "?$select=id,name,size,lastModifiedDateTime,folder,file,cTag,eTag,@microsoft.graph.downloadUrl&$top=200"
        while url:
            j = self.get(url).json(); yield from j.get("value", []); url = j.get("@odata.nextLink")
    def recorrer(self, cuenta, raiz, rel=""):
        for it in self.hijos(cuenta, raiz + ("/" + rel if rel else "")):
            nombre = it["name"]
            if nombre.startswith("~$") or nombre.startswith("."): continue
            sub = f"{rel}/{nombre}" if rel else nombre
            if "folder" in it: yield from self.recorrer(cuenta, raiz, sub)
            elif EXT.search(nombre): yield sub, it

# ---------------------------------------------------------------- utilidades
def norm(s): return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().upper()
def anio_mes(ruta_rel):
    partes = ruta_rel.split("/")[:-1]
    anio = next((p for p in partes if re.fullmatch(r"(19|20)\d{2}", p)), None)
    mes = None
    if anio:
        i = partes.index(anio); mes = partes[i+1] if i+1 < len(partes) else "General"
    else:
        for p in partes:
            n = norm(p).replace("SETIEMBRE", "SEPTIEMBRE")
            if any(m in n for m in MESES): mes = p; break
    return anio, mes
def objeto_storage(carpeta_id, ruta_rel):
    seguro = re.sub(r"[^\w./ ()\-]", "_", ruta_rel)
    return f"{carpeta_id}/{seguro}"

# ---------------------------------------------------------------- sincronización
def sincronizar(g, carpeta):
    cid = carpeta["id"]; log = sb_insert("ma_sync_log", {"carpeta_id": cid})
    nuevos = cambiados = eliminados = 0
    try:
        existentes = {a["ruta"]: a for a in sb_select("ma_archivos", {"carpeta_id": f"eq.{cid}", "select": "id,ruta,hash,storage"})}
        vistos = set()
        for ruta_rel, it in g.recorrer(carpeta["cuenta"], carpeta["ruta"]):
            vistos.add(ruta_rel)
            hash_ = it.get("cTag") or it.get("eTag")
            prev = existentes.get(ruta_rel)
            if prev and prev["hash"] == hash_: continue          # sin cambios
            contenido = requests.get(it["@microsoft.graph.downloadUrl"]).content
            obj = objeto_storage(cid, ruta_rel)
            storage_put(obj, contenido)
            anio, mes = anio_mes(ruta_rel)
            sb_upsert("ma_archivos", {
                "carpeta_id": cid, "ruta": ruta_rel, "nombre": it["name"], "anio": anio, "mes": mes,
                "tamano": it.get("size"), "modificado": it.get("lastModifiedDateTime"),
                "storage": obj, "hash": hash_, "sincronizado": datetime.now(timezone.utc).isoformat()
            }, "carpeta_id,ruta")
            if prev: cambiados += 1
            else: nuevos += 1
            print(f"  {'actualizado' if prev else 'nuevo'}: {ruta_rel}")
        # borrados en OneDrive → borrar de la base y del Storage
        sobrantes = [a for r, a in existentes.items() if r not in vistos]
        if sobrantes:
            storage_delete([a["storage"] for a in sobrantes])
            for a in sobrantes: sb_delete("ma_archivos", {"id": f"eq.{a['id']}"})
            eliminados = len(sobrantes)
        sb_update("ma_sync_log", {"id": f"eq.{log['id']}"},
                  {"fin": datetime.now(timezone.utc).isoformat(), "nuevos": nuevos, "cambiados": cambiados, "eliminados": eliminados})
        print(f"[{carpeta['nombre']}] nuevos={nuevos} cambiados={cambiados} eliminados={eliminados}")
    except Exception as e:
        sb_update("ma_sync_log", {"id": f"eq.{log['id']}"}, {"fin": datetime.now(timezone.utc).isoformat(), "error": str(e)[:900]})
        print(f"[{carpeta['nombre']}] ERROR: {e}", file=sys.stderr); raise

def main():
    carpetas = sb_select("ma_carpetas", {"activa": "eq.true", "select": "*"})
    if not carpetas: print("No hay carpetas activas en ma_carpetas."); return
    g = Graph()
    fallo = False
    for c in carpetas:
        try: sincronizar(g, c)
        except Exception: fallo = True
    sys.exit(1 if fallo else 0)

if __name__ == "__main__":
    main()

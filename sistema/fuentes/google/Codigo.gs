/**
 * M&A Capital — Bitácora Ejecutiva, Tablero de Notas y Pulso Comercial
 * Servidor en Google Apps Script. La base de datos es esta misma Hoja de cálculo de Google.
 *
 * Cómo se instala (una sola vez):
 *   1. Crea una Hoja de cálculo de Google nueva (por ejemplo «M&A · Bitácora y Ventas»).
 *   2. Extensiones › Apps Script. Borra lo que haya y pega TODO este archivo. Guarda.
 *   3. Implementar › Nueva implementación › tipo «Aplicación web».
 *        Ejecutar como: Yo        ·        Quién tiene acceso: Cualquier usuario
 *      Autoriza los permisos que pide Google (es tu propia cuenta).
 *   4. Copia la URL que termina en /exec y pégala en el dashboard (o envíala para dejarla fija).
 *   5. (Opcional) Ejecuta una vez la función instalarAvisoDiario para el correo de cada mañana.
 *
 * Seguridad: aunque la URL sea pública, cada pedido trae la sesión del dashboard M&A.
 * El script la verifica con Supabase y solo responde a usuarios con el módulo correspondiente.
 */

const SB_URL  = '__SUPABASE_URL__';
const SB_ANON = '__SUPABASE_ANON__';

const TABLAS = {
  Tareas: ['id','titulo','descripcion','responsable','proyecto','prioridad','estado','avance','inicio','limite','obstaculo','impacto','creado','creado_por','actualizado','actualizado_por','cerrado','etiquetas','recurrencia','depende_de','enlace','aprobador','aprobacion'],
  Notas:  ['id','titulo','texto','color','fijada','tarea_id','autor','creado','actualizado','tablero','etiquetas','recordar','orden'],
  Comentarios: ['id','tarea_id','texto','autor','creado'],
  Historial: ['fecha','usuario','tarea_id','titulo','cambio'],
  Ventas: ['Fecha','Producto','Categoria','Cliente','Vendedor','Cantidad','Precio_unitario','Costo_unitario'],
  Gastos: ['Fecha','Concepto','Categoria','Tipo','Monto'],
  Stock:  ['Producto','Categoria','Stock','Stock_minimo','Costo_unitario','Precio_venta']
};

/* ---------------- entrada ---------------- */
function doGet() {
  return ContentService.createTextOutput('M&A Capital · servicio de Bitácora Ejecutiva y Pulso Comercial activo.');
}

function doPost(e) {
  let r;
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    prepararHoja_();
    const yo = usuario_(b.token);
    const [area, accion] = String(b.accion || '').split('.');
    if (area === 'bitacora') { exigir_(yo, b.token, 'bitacora'); r = bitacora_(accion, b, yo); }
    else if (area === 'ventas') { exigir_(yo, b.token, 'ventas'); r = ventas_(accion, b, yo); }
    else if (area === 'notas') { exigir_(yo, b.token, 'notas'); r = notas_(accion, b, yo); }
    else if (area === 'info') r = { email: yo.email, hoja: SpreadsheetApp.getActive().getUrl() };
    else throw new Error('Acción desconocida');
    r = { ok: true, datos: r };
  } catch (err) {
    r = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- sesión del dashboard (Supabase) ---------------- */
function usuario_(token) {
  if (!token) throw new Error('Falta la sesión: entra desde el dashboard M&A.');
  const cache = CacheService.getScriptCache(), k = 'u_' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const c = cache.get(k); if (c) return JSON.parse(c);
  const res = UrlFetchApp.fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('La sesión venció: vuelve a entrar al dashboard.');
  const u = { email: String(JSON.parse(res.getContentText()).email || '').toLowerCase() };
  cache.put(k, JSON.stringify(u), 300);
  return u;
}
function exigir_(yo, token, modulo) {
  const cache = CacheService.getScriptCache(), k = 'm_' + modulo + '_' + yo.email;
  if (cache.get(k) === '1') return;
  const res = UrlFetchApp.fetch(SB_URL + '/rest/v1/rpc/ma_tiene_modulo', { method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ p_modulo: modulo }), headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200 || res.getContentText().trim() !== 'true') throw new Error('Tu usuario no tiene acceso a este módulo.');
  cache.put(k, '1', 300);
}

/* ---------------- hoja ---------------- */
function prepararHoja_() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLAS).forEach(n => {
    let h = ss.getSheetByName(n);
    if (!h) { h = ss.insertSheet(n); h.getRange(1, 1, 1, TABLAS[n].length).setValues([TABLAS[n]]).setFontWeight('bold').setBackground('#1b3a5c').setFontColor('#ffffff'); h.setFrozenRows(1); return; }
    const cab = h.getLastColumn() ? h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map(String) : [];
    const faltan = TABLAS[n].filter(c => cab.indexOf(c) < 0);
    if (faltan.length) h.getRange(1, cab.length + 1, 1, faltan.length).setValues([faltan]).setFontWeight('bold').setBackground('#1b3a5c').setFontColor('#ffffff');
  });
  const hoja1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (hoja1 && ss.getSheets().length > Object.keys(TABLAS).length && hoja1.getLastRow() === 0) ss.deleteSheet(hoja1);
}
function zona_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }
function valor_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, zona_(), v.getHours() || v.getMinutes() ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
  return v;
}
function leer_(nombre) {
  const h = SpreadsheetApp.getActive().getSheetByName(nombre);
  const n = h.getLastRow(); if (n < 2) return [];
  const datos = h.getRange(1, 1, n, h.getLastColumn()).getValues(), cab = datos[0].map(String);
  return datos.slice(1).filter(f => f.some(x => x !== '' && x !== null)).map(f => { const o = {}; cab.forEach((c, i) => { if (c) o[c] = valor_(f[i]); }); return o; });
}
function guardar_(nombre, obj) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const h = SpreadsheetApp.getActive().getSheetByName(nombre), cab = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map(String);
    const col = cab.indexOf('id') + 1;
    const ids = col && h.getLastRow() > 1 ? h.getRange(2, col, h.getLastRow() - 1, 1).getValues().map(x => String(x[0])) : [];
    const fila = cab.map(c => obj[c] == null ? '' : obj[c]);
    const i = ids.indexOf(String(obj.id));
    if (i >= 0) h.getRange(i + 2, 1, 1, cab.length).setValues([fila]); else h.appendRow(fila);
    return obj;
  } finally { lock.releaseLock(); }
}
function borrar_(nombre, id) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const h = SpreadsheetApp.getActive().getSheetByName(nombre);
    if (h.getLastRow() < 2) return false;
    const col = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map(String).indexOf('id') + 1;
    const ids = h.getRange(2, col, h.getLastRow() - 1, 1).getValues().map(x => String(x[0]));
    const i = ids.indexOf(String(id)); if (i < 0) return false;
    h.deleteRow(i + 2); return true;
  } finally { lock.releaseLock(); }
}
const ahora_ = () => Utilities.formatDate(new Date(), zona_(), "yyyy-MM-dd'T'HH:mm:ss");
function anotar_(yo, t, cambio) {
  SpreadsheetApp.getActive().getSheetByName('Historial').appendRow([ahora_(), yo.email, t.id, t.titulo, cambio]);
}
function mover_(fecha, rec) {
  if (!fecha) return '';
  const d = new Date(String(fecha).slice(0, 10) + 'T12:00:00');
  if (rec === 'Semanal') d.setDate(d.getDate() + 7);
  else if (rec === 'Quincenal') d.setDate(d.getDate() + 14);
  else if (rec === 'Mensual') d.setMonth(d.getMonth() + 1);
  else if (rec === 'Trimestral') d.setMonth(d.getMonth() + 3);
  else return fecha;
  return Utilities.formatDate(d, zona_(), 'yyyy-MM-dd');
}

/* ---------------- Bitácora Ejecutiva ---------------- */
function bitacora_(accion, b, yo) {
  if (accion === 'listar') return { tareas: leer_('Tareas'), notas: leer_('Notas'), comentarios: leer_('Comentarios'), historial: leer_('Historial').slice(-400), hoja: SpreadsheetApp.getActive().getUrl() };
  if (accion === 'guardarTarea') {
    const t = Object.assign({}, b.tarea || {});
    if (!t.titulo) throw new Error('La tarea necesita un título.');
    const antes = t.id ? leer_('Tareas').filter(x => String(x.id) === String(t.id))[0] : null;
    if (!t.id) { t.id = Utilities.getUuid(); t.creado = ahora_(); t.creado_por = yo.email; }
    t.actualizado = ahora_(); t.actualizado_por = yo.email;
    if (t.estado === 'Hecha' && !t.cerrado) t.cerrado = ahora_().slice(0, 10);
    if (t.estado !== 'Hecha') t.cerrado = '';
    guardar_('Tareas', t);
    if (!antes) anotar_(yo, t, 'Creó la tarea');
    else {
      if (antes.estado !== t.estado) anotar_(yo, t, 'Estado: ' + (antes.estado || '—') + ' → ' + t.estado + (t.estado === 'Bloqueada' && t.obstaculo ? ' (' + t.obstaculo + ')' : ''));
      if (String(antes.responsable || '') !== String(t.responsable || '')) anotar_(yo, t, 'Responsable: ' + (t.responsable || '—'));
      if (String(antes.aprobacion || '') !== String(t.aprobacion || '') && t.aprobacion) anotar_(yo, t, 'Aprobación: ' + t.aprobacion);
    }
    // tarea recurrente: al cerrarla se crea la siguiente
    let siguiente = null;
    if (t.estado === 'Hecha' && (!antes || antes.estado !== 'Hecha') && t.recurrencia && t.recurrencia !== 'No') {
      siguiente = Object.assign({}, t, { id: Utilities.getUuid(), estado: 'Pendiente', avance: 0, cerrado: '', obstaculo: '', impacto: '', aprobacion: t.aprobador ? 'Pendiente' : '',
        inicio: mover_(t.inicio, t.recurrencia), limite: mover_(t.limite, t.recurrencia), creado: ahora_(), creado_por: yo.email });
      guardar_('Tareas', siguiente); anotar_(yo, siguiente, 'Creada automáticamente (' + t.recurrencia.toLowerCase() + ')');
    }
    return siguiente ? Object.assign({}, t, { _siguiente: siguiente }) : t;
  }
  if (accion === 'comentar') {
    if (!b.tarea_id || !String(b.texto || '').trim()) throw new Error('Escribe el comentario.');
    return guardar_('Comentarios', { id: Utilities.getUuid(), tarea_id: b.tarea_id, texto: String(b.texto).trim(), autor: yo.email, creado: ahora_() });
  }
  if (accion === 'borrarComentario') return borrar_('Comentarios', b.id);
  if (accion === 'borrarTarea') return borrar_('Tareas', b.id);
  if (accion === 'guardarNota') {
    const n = Object.assign({}, b.nota || {});
    if (!n.id) { n.id = Utilities.getUuid(); n.creado = ahora_(); n.autor = yo.email; }
    n.actualizado = ahora_();
    return guardar_('Notas', n);
  }
  if (accion === 'borrarNota') return borrar_('Notas', b.id);
  throw new Error('Acción desconocida');
}

/* ---------------- Tablero de Notas ---------------- */
function notas_(accion, b, yo) {
  if (accion === 'listar') return { notas: leer_('Notas'), tareas: leer_('Tareas').filter(t => t.estado !== 'Hecha').map(t => ({ id: t.id, titulo: t.titulo })), hoja: SpreadsheetApp.getActive().getUrl() };
  if (accion === 'guardar') return bitacora_('guardarNota', b, yo);
  if (accion === 'borrar') return borrar_('Notas', b.id);
  throw new Error('Acción desconocida');
}

/* ---------------- Pulso Comercial ---------------- */
function ventas_(accion, b, yo) {
  if (accion === 'datos') return { ventas: leer_('Ventas'), gastos: leer_('Gastos'), stock: leer_('Stock'), hoja: SpreadsheetApp.getActive().getUrl() };
  throw new Error('Acción desconocida');
}

/* ---------------- correo de cada mañana (opcional) ---------------- */
function instalarAvisoDiario() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'avisoDiario').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('avisoDiario').timeBased().everyDays(1).atHour(7).create();
}
function avisoDiario() {
  prepararHoja_();
  const hoy = Utilities.formatDate(new Date(), zona_(), 'yyyy-MM-dd');
  const abiertas = leer_('Tareas').filter(t => t.estado !== 'Hecha' && String(t.responsable || '').indexOf('@') > 0);
  const porPersona = {}, aprobar = {}, recordar = {};
  abiertas.forEach(t => { const l = String(t.limite || ''); if ((l && l <= hoy) || t.estado === 'Bloqueada') (porPersona[t.responsable] = porPersona[t.responsable] || []).push(t); });
  leer_('Tareas').forEach(t => { if (t.aprobacion === 'Pendiente' && String(t.aprobador || '').indexOf('@') > 0) (aprobar[t.aprobador] = aprobar[t.aprobador] || []).push(t); });
  leer_('Notas').forEach(n => { if (String(n.recordar || '').slice(0, 10) === hoy && String(n.autor || '').indexOf('@') > 0) (recordar[n.autor] = recordar[n.autor] || []).push(n); });
  Object.keys(aprobar).concat(Object.keys(recordar)).forEach(e => { porPersona[e] = porPersona[e] || []; });
  Object.keys(porPersona).forEach(email => {
    const ts = porPersona[email].sort((a, b) => String(a.limite).localeCompare(String(b.limite)));
    const extra = (aprobar[email] || []).map(t => `<li>Por aprobar: <b>${t.titulo}</b>${t.responsable ? ' (' + t.responsable + ')' : ''}</li>`).join('') +
      (recordar[email] || []).map(n => `<li>Recordatorio: <b>${n.titulo || ''}</b> ${n.texto || ''}</li>`).join('');
    const filas = ts.map(t => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${t.titulo}</b>${t.proyecto ? '<br><span style="color:#888">' + t.proyecto + '</span>' : ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${t.limite || '—'}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${t.estado === 'Bloqueada' ? 'Bloqueada: ' + (t.obstaculo || '') : (t.limite < hoy ? 'Vencida' : 'Vence hoy')}</td></tr>`).join('');
    MailApp.sendEmail({ to: email, subject: `Bitácora Ejecutiva · pendientes de hoy`,
      htmlBody: `<div style="font-family:Arial,sans-serif;color:#0f1c2e"><h2 style="color:#1b3a5c;margin:0 0 8px">Buenos días</h2>${ts.length ? '<p>Estas tareas están vencidas, vencen hoy o están bloqueadas:</p>' : ''}
        <table style="border-collapse:collapse;font-size:14px">${filas}</table>${extra ? '<ul style="font-size:14px">' + extra + '</ul>' : ''}<p style="color:#888;font-size:12px">M&amp;A Capital · Bitácora Ejecutiva</p></div>` });
  });
}

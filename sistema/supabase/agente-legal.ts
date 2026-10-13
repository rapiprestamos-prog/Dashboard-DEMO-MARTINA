// =====================================================================
//  Edge Function: agente-legal
//  Lee los textos de los documentos que manda el navegador (de la carpeta Legal de OneDrive)
//  y le pide a Claude el análisis. Solo usuarios con el módulo "agente_legal".
//
//  Secretos (Supabase → Edge Functions → Secrets):
//    ANTHROPIC_API_KEY   clave de la API de Anthropic (obligatoria)
//    ANTHROPIC_MODEL     modelo a usar (opcional; por defecto claude-sonnet-5-5)
//  La clave solo vive aquí, en el servidor: nunca en el HTML.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Doc = { nombre: string; texto: string };
// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

const SISTEMA = `Eres el asistente legal interno de M&A Capital (Panamá). Trabajas SOLO con los documentos y datos que se te entregan.
Reglas:
- No inventes datos. Si algo no aparece en los documentos, dilo claramente o deja el valor vacío.
- Indica el nombre del archivo de donde sale cada dato.
- Escribe en español salvo que se pida otro idioma.
- Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, con la forma indicada.`;

const docsTxt = (docs: Doc[] = []) =>
  docs.map((d) => `<<<DOCUMENTO: ${d.nombre}>>>\n${d.texto}\n<<<FIN: ${d.nombre}>>>`).join("\n\n");

const TAREAS: Record<string, (b: Body) => string> = {
  caso_meta: (b) => `Caso (subcarpeta): ${b.caso}
Con los documentos, identifica la sociedad del grupo que participa y el tipo de proceso (por ejemplo, compraventa de inmueble, contrato de servicios, confidencialidad).
Devuelve: {"sociedad":"","tipo_proceso":""} (vacío si no se puede saber).

${docsTxt(b.documentos)}`,

  due_diligence: (b) => `Caso: ${b.caso}
Datos a revisar: ${(b.datos || []).join(", ")}.
Extrae de TODOS los documentos esos datos (por ejemplo: partes con nombres, cédulas o RUC; fincas con número y ubicación; fechas de firma, vencimientos y vigencias; precios, montos y abonos; hipotecas, gravámenes o limitaciones) y compara el mismo dato entre documentos.
Devuelve: {"datos":[{"dato":"nombre del dato","valor":"valor principal","valores":[{"documento":"archivo","valor":"como aparece"}],"documentos":["archivos donde aparece"],"estado":"coincide|revisar|diferencia","nota":"explicación breve si no es coincide"}]}
"diferencia" = dos documentos dicen cosas distintas; "revisar" = incompleto, vencido o dudoso; "coincide" = todos concuerdan.

${docsTxt(b.documentos)}`,

  redaccion_campos: (b) => `Caso: ${b.caso}${b.sociedad ? `\nSociedad del caso: ${b.sociedad}` : ""}
Idioma de los valores: ${b.idioma || "Español"}.
La plantilla tiene estos campos entre corchetes: ${(b.campos || []).map((c: string) => `[${c}]`).join(", ")}.
Busca el valor de cada campo en los documentos del caso. Si un campo no aparece, deja "valor" vacío. Escribe los valores tal como deben ir en el documento (montos en letras si el campo lo pide).
Devuelve: {"campos":{"NOMBRE DEL CAMPO":{"valor":"","fuente":"archivo"}}} usando los nombres de campo exactamente como están (sin corchetes).

TEXTO DE LA PLANTILLA:
${b.plantilla || ""}

DOCUMENTOS DEL CASO:
${docsTxt(b.documentos)}`,

  redaccion_cambio: (b) => `Pedido de cambio: "${b.pedido}"
Idioma: ${b.idioma || "Español"}.
Estos son los párrafos del documento (índice y texto). Propón el cambio mínimo necesario: modifica solo los párrafos que hagan falta y conserva los campos entre corchetes que no se deban tocar.
Devuelve: {"cambios":[{"parrafo":índice,"propuesto":"texto completo nuevo del párrafo","explicacion":"qué cambiaste"}]}

${(b.parrafos || []).map((p: { i: number; texto: string }) => `[${p.i}] ${p.texto}`).join("\n")}`,

  redaccion_validar: (b) => `Revisa la consistencia de este documento ya llenado: montos en letras contra números, nombres y cédulas contra los documentos del caso, fechas y plazos coherentes, campos vacíos o entre corchetes que quedaron sin llenar.
Devuelve: {"validaciones":[{"estado":"OK|PENDIENTE|ERROR","texto":"qué revisaste y qué encontraste"}]}

DOCUMENTO:
${b.texto || ""}

DOCUMENTOS DEL CASO:
${docsTxt(b.documentos)}`,

  cierre: (b) => `Caso: ${b.caso}
Checklist del proceso "${b.checklist}":
${(b.items || []).map((x: { documento: string; detalle?: string }, i: number) => `${i + 1}. ${x.documento}${x.detalle ? ` (${x.detalle})` : ""}`).join("\n")}
Archivos de la carpeta del caso: ${(b.archivos || []).map((a: { nombre: string; modificado: string }) => `${a.nombre} (modificado ${a.modificado})`).join("; ")}
Para cada documento del checklist, busca el archivo que le corresponde y decide su estado: "Final" (firmado/completo y vigente), "Por modificar" (borrador, falta firma, vencido o con algo que corregir) o "Falta" (no hay archivo).
Devuelve: {"items":[{"documento":"del checklist","archivo":"archivo encontrado o vacío","estado":"Final|Por modificar|Falta","motivo":"breve"}],"que_falta":["pasos concretos para cerrar"],"alertas":["vencimientos u otros riesgos con fecha, si los hay"]}

${docsTxt(b.documentos)}`,

  correo_seguimiento: (b) => `Redacta un correo de seguimiento profesional y breve para cerrar el caso "${b.caso}" (checklist "${b.checklist}").
Pendientes: ${JSON.stringify(b.que_falta || [])}
Estado de documentos: ${JSON.stringify(b.items || [])}
Alertas: ${JSON.stringify(b.alertas || [])}
No inventes destinatarios ni nombres que no estén en los datos; usa "[Nombre]" donde haga falta.
Devuelve: {"asunto":"","cuerpo":""}`,

  comparar: (b) => `Compara estos dos documentos y lista las diferencias relevantes (partes, montos, fechas, plazos, cláusulas añadidas o quitadas, obligaciones).
Devuelve: {"resumen":"","diferencias":[{"tema":"","a":"lo que dice A","b":"lo que dice B","importancia":"Alta|Media|Baja"}]}

DOCUMENTO A:
${docsTxt([b.a])}

DOCUMENTO B:
${docsTxt([b.b])}`,

  consultar: (b) => `Pregunta: ${b.pregunta}
Responde usando solo este documento y copia los fragmentos que lo respaldan.
Devuelve: {"respuesta":"","citas":[{"texto":"fragmento literal","ubicacion":"cláusula o sección"}]}

${docsTxt([b.documento])}`,

  semaforo: (b) => `Caso: ${b.caso}
Evalúa el riesgo legal del caso con sus documentos: vencimientos próximos o pasados, firmas o poderes faltantes, gravámenes, diferencias entre documentos, cláusulas desfavorables.
Devuelve: {"nivel":"verde|amarillo|rojo","resumen":"una línea","riesgos":[{"riesgo":"","gravedad":"Alta|Media|Baja","documento":"archivo"}]}

${docsTxt(b.documentos)}`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const clave = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const modelo = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  if (!clave) return json({ error: "Falta configurar ANTHROPIC_API_KEY en Supabase → Edge Functions → Secrets." }, 500);

  // ¿Quién llama y tiene el módulo?
  const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { data: u, error: eu } = await comoUsuario.auth.getUser();
  if (eu || !u?.user?.email) return json({ error: "Sesión no válida" }, 401);
  const { data: puede, error: ep } = await comoUsuario.rpc("ma_tiene_modulo", { p_modulo: "agente_legal" });
  if (ep) return json({ error: "No se pudo revisar el permiso: " + ep.message }, 500);
  if (puede !== true) return json({ error: "Tu usuario no tiene acceso al Agente Legal" }, 403);

  let b: Body = {};
  try { b = await req.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  const tarea = String(b.tarea || "");

  let messages: { role: string; content: string }[];
  if (tarea === "chat") {
    const hist = (b.mensajes || []) as { role: string; content: string }[];
    messages = [
      { role: "user", content: `Documentos del caso "${b.caso}":\n\n${docsTxt(b.documentos)}\n\nVoy a hacerte preguntas sobre estos documentos. Responde solo con lo que digan. Devuelve siempre {"respuesta":"..."}.` },
      { role: "assistant", content: '{"respuesta":"Entendido. ¿Qué necesitas saber?"}' },
      ...hist.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    ];
  } else {
    const armar = TAREAS[tarea];
    if (!armar) return json({ error: "Tarea desconocida: " + tarea }, 400);
    messages = [{ role: "user", content: armar(b) }];
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": clave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: modelo, max_tokens: tarea === "chat" ? 4000 : 8000, system: SISTEMA, messages }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "Error de la IA: " + (out?.error?.message || r.statusText) }, 502);
  const texto: string = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");

  const i = texto.indexOf("{"), j = texto.lastIndexOf("}");
  try {
    return json({ resultado: JSON.parse(texto.slice(i, j + 1)) });
  } catch {
    if (tarea === "chat") return json({ resultado: { respuesta: texto } });
    return json({ error: "La IA no devolvió un resultado válido. Intenta de nuevo." }, 502);
  }
});
